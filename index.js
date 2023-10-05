const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
require('dotenv').config()
const server = http.createServer(app);
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion} = require('mongodb');
const port = process.env.PORT || 3000;

// Configure CORS to allow requests from your React application
const corsOptions = {
    origin: `*`,
    methods: ['GET', 'POST', 'DELETE', 'PUT'],
};

const io = new Server(server, {
    cors: corsOptions, // Use the same corsOptions you defined for Express
});

app.use(cors(corsOptions)); // Use the cors middleware with the specified options

app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nmmhgrv.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();
        // Send a ping to confirm a successful connection

        const roomsCollection = client.db("codeEditorDB").collection("room");

        // Room api
        app.post('/room', async (req, res) => {
            try {
                const room = req.body;
                const result = await roomsCollection.insertOne(room);
                console.log(result)
                res.send(result);

            } catch (error) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error' });
            }
        })

        app.get('/myrooms/:email', async (req, res) => {
            const email = req.params.email;
            const query = { 'member.email': email };
            const result = await roomsCollection.find(query).toArray();
            res.send(result);
        })
        app.get('/room/:id', async (req, res) => {
            const id = req.params.id;
            const query = { roomId: id };
            const result = await roomsCollection.findOne(query);
            res.send(result);
        })

        let userSocketMap = [];
        function getAllConnectedClients(roomId) {
            // Map
            return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
                (socketId) => {
                    const {roomId, username, email, photoURL, time} = userSocketMap
                    return {
                        roomId, username, email, photoURL, socketId, time
                    };
                }
            );
        }

        io.on('connection', (socket) => {
            console.log('socket connected', socket.id);

            socket.on("JOIN", async ({ roomId, username, email, photoURL }) => {
                userSocketMap ={roomId, username, email, photoURL, time :new Date()}
                socket.join(roomId);
                console.log(userSocketMap)
                const newMember = {
                    username,
                    socketId: socket.id,
                    email,
                    photoURL,
                    time :new Date()
                };
            
                const query = { roomId: roomId };
                const existingRoom = await roomsCollection.findOne(query);
                if (!existingRoom) {
                    // Handle room not found error
                    socket.emit('room_not_found', { message: 'Room not found' });
                    return;
                }
            
                // Ensure existingRoom.member is an array or initialize it as an empty array
                if (!Array.isArray(existingRoom.member)) {
                    existingRoom.member = [];
                }
            
                // Check if a member with the same email already exists
                const existingMember = existingRoom.member.find(member => member.email === email);
            
                if (!existingMember) {
                    // If the member is not found, add the new member to the list
                    existingRoom.member.push(newMember);
                    const options = { upsert: true };
                    const update = {
                        $set: {
                            member: existingRoom.member,
                        },
                    };
                    await roomsCollection.updateOne(query, update, options);
                }
                else {
                    // If that member remains, update the time field of that member
                    const existingMemberIndex = existingRoom.member.findIndex(member => member.email === email);
                    if (existingMemberIndex !== -1) {
                        existingRoom.member[existingMemberIndex].time = new Date();
                    }
                    const options = { upsert: true };
                    const update = {
                        $set: {
                            member: existingRoom.member,
                        },
                    };
                    await roomsCollection.updateOne(query, update, options);
                }
                
                const clients = getAllConnectedClients(roomId);
            
                // Emit the JOINED event to all clients in the room
                clients.forEach(({ socketId }) => {
                    io.to(socketId).emit("JOINED", {
                        clients,
                        username,
                        socketId: socket.id,
                        email,
                        photoURL,
                    });
                });
            });
            
            socket.on("CODE_CHANGE", async ({ roomId, code }) => {
                try {
                    const query = { roomId: roomId };
                    const existingRoom = await roomsCollection.findOne(query);
                    if (!existingRoom) {
                        // Handle room not found error
                        socket.emit('room_not_found', { message: 'Room not found' });
                        return;
                    }
                    const options = { upsert: true };
                    const update = {
                        $set: {
                            code: code,
                            modifi: new Date()
                        },
                    };
                    await roomsCollection.updateOne(query, update, options);

                    socket.in(roomId).emit("CODE_CHANGE", { code });
                } catch (error) {
                    console.log(error)
                }

            });

            socket.on("SYNC_CODE", async ({ socketId, code, roomId }) => {
                io.to(socketId).emit("CODE_CHANGE", { code });
            });

            socket.on('disconnecting', () => {
                const rooms = [...socket.rooms];
                rooms.forEach((roomId) => {
                    socket.in(roomId).emit("DISCONNECTED", {
                        socketId: socket.id,
                        username: userSocketMap[socket.id],
                    });
                });
                delete userSocketMap[socket.id];
                socket.leave();
            });
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
        
                // Find the index of the member with the given email
                const memberIndex = existingRoom.member.findIndex(member => member.email === email);
        
                if (memberIndex === -1) {
                    return res.status(404).json({ message: 'Member not found in the room' });
                }
        
                // Remove the member from the member array
                existingRoom.member.splice(memberIndex, 1);
        
                // Check if there are no members left in the room
                if (existingRoom.member.length === 0) {
                    // If there are no members, delete the room
                    await roomsCollection.deleteOne(query);
                    return res.status(200).json({ message: 'Room deleted since there are no members left' });
                }
        
                // Update the room with the modified member array
                const update = {
                    $set: {
                        member: existingRoom.member,
                    },
                };
        
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

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        app.get('/', (req, res) => {
            res.send('Hello CodeFlow');
        });

        server.listen(port, () => {
            console.log(`listening on :${port}`);
        });
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


