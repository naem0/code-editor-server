const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

// Middleware
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT'] }));
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nmmhgrv.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let roomsCollection;

async function connectDB() {
    try {
        await client.connect();
        roomsCollection = client.db('codeEditorDB').collection('room');
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        process.exit(1);
    }
}

// Room API Endpoints
app.post('/room', async (req, res) => {
    try {
        const room = req.body;
        const result = await roomsCollection.insertOne(room);
        res.send(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/myrooms/:email', async (req, res) => {
    try {
        const email = req.params.email;
        const query = { 'member.email': email };
        const result = await roomsCollection.find(query).toArray();
        res.send(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/room/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const query = { roomId: id };
        const result = await roomsCollection.findOne(query);
        res.send(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.delete('/room/:roomId/member/:email', async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const email = req.params.email;
        const query = { roomId: roomId };
        const existingRoom = await roomsCollection.findOne(query);

        if (!existingRoom) {
            return res.status(404).json({ message: 'Room not found' });
        }

        const memberIndex = existingRoom.member.findIndex(member => member.email === email);
        if (memberIndex === -1) {
            return res.status(404).json({ message: 'Member not found in the room' });
        }

        existingRoom.member.splice(memberIndex, 1);

        if (existingRoom.member.length === 0) {
            await roomsCollection.deleteOne(query);
            return res.status(200).json({ message: 'Room deleted since there are no members left' });
        }

        const update = { $set: { member: existingRoom.member } };
        const result = await roomsCollection.updateOne(query, update);

        if (result.modifiedCount === 1) {
            return res.status(200).json({ message: 'Member deleted from the room successfully' });
        } else {
            return res.status(500).json({ message: 'Failed to delete member from the room' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Socket.IO Event Handlers
let userSocketMap = [];

function getAllConnectedClients(roomId) {
    return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map((socketId) => {
        const { roomId, username, email, photoURL, time } = userSocketMap;
        return {
            roomId,
            username,
            email,
            photoURL,
            socketId,
            time,
        };
    });
}

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('JOIN', async ({ roomId, username, email, photoURL }) => {
        userSocketMap = { roomId, username, email, photoURL, time: new Date() };
        socket.join(roomId);

        const newMember = {
            username,
            socketId: socket.id,
            email,
            photoURL,
            time: new Date(),
        };

        const query = { roomId: roomId };
        const existingRoom = await roomsCollection.findOne(query);

        if (!existingRoom) {
            socket.emit('room_not_found', { message: 'Room not found' });
            return;
        }

        if (!Array.isArray(existingRoom.member)) {
            existingRoom.member = [];
        }

        const existingMember = existingRoom.member.find(member => member.email === email);

        if (!existingMember) {
            existingRoom.member.push(newMember);
        } else {
            const existingMemberIndex = existingRoom.member.findIndex(member => member.email === email);
            existingRoom.member[existingMemberIndex].time = new Date();
        }

        const update = { $set: { member: existingRoom.member } };
        await roomsCollection.updateOne(query, update);

        const clients = getAllConnectedClients(roomId);
        clients.forEach(({ socketId }) => {
            io.to(socketId).emit('JOINED', {
                clients,
                username,
                socketId: socket.id,
                email,
                photoURL,
            });
        });
    });

    socket.on('CODE_CHANGE', async ({ roomId, code }) => {
        try {
            const query = { roomId: roomId };
            const update = { $set: { code: code, modifi: new Date() } };
            await roomsCollection.updateOne(query, update);
            socket.in(roomId).emit('CODE_CHANGE', { code });
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('SYNC_CODE', ({ socketId, code, roomId }) => {
        io.to(socketId).emit('CODE_CHANGE', { code });
    });

    socket.on('disconnecting', () => {
        const rooms = [...socket.rooms];
        rooms.forEach((roomId) => {
            socket.in(roomId).emit('DISCONNECTED', {
                socketId: socket.id,
                username: userSocketMap[socket.id],
            });
        });
        delete userSocketMap[socket.id];
        socket.leave();
    });
});

// Start Server
const port = process.env.PORT || 3000;

connectDB().then(() => {
    server.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
});