const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000;

// Configure CORS to allow requests from your React application
const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'PUT'],
};

const io = new Server(server, {
    cors: corsOptions, // Use the same corsOptions you defined for Express
});

app.use(cors(corsOptions)); // Use the cors middleware with the specified options

app.use(express.json());

const uri = "mongodb+srv://codeEditor:URJdZnSHq7VRz6tX@cluster0.nmmhgrv.mongodb.net/?retryWrites=true&w=majority";

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

        const usersCollection = client.db("codeEditorDB").collection("user");
        const roomsCollection = client.db("codeEditorDB").collection("room");

        //user api
        app.post('/user', async (req, res) => {
            try {
                const user = req.body;
                const query = { email: user.email }
                const existingUser = await usersCollection.findOne(query);

                if (existingUser) {
                    return res.send({ message: 'user already exists' })
                }

                const result = await usersCollection.insertOne(user);
                res.send(result);
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error', error });
            }
        });

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
            const query = { email: email };
            const result = await roomsCollection.find(query).toArray();
            res.send(result);
        })
        app.get('/room/:id', async (req, res) => {
            const id = req.params.id;
            const query = { roomId: id };
            const result = await roomsCollection.findOne(query);
            res.send(result);
        })

        app.put("/room", async (req, res) => {

            try {
                const room = req.body;
                const id = req.params.id;
                const query = { roomId: id };
                const existingRoom = await roomsCollection.findOne(query);
                if (!existingRoom) {
                    return res.send({ message: 'Room not exists' });
                }
                const options = { upsert: true };
                const newMamber = (room.mamber(...menubar));
                const roomed = {
                    $set: {
                        mamber: newMamber,
                    },
                };
                const result = await roomsCollection.updateOne(query, roomed, options);
                res.send(result);
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error' });
            }
        });
        const userSocketMap = {};
        function getAllConnectedClients(roomId) {
            // Map
            return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
                (socketId) => {
                    return {
                        socketId,
                        username: userSocketMap[socketId],
                    };
                }
            );
        }

        io.on('connection', (socket) => {
            console.log('socket connected', socket.id);

            socket.on("JOIN", async ({ roomId, username, email, photoURL }) => {
                userSocketMap[socket.id] = username;
                socket.join(roomId);
            
                const newMember = {
                    username,
                    socketId: socket.id,
                    email,
                    photoURL,
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
            
                console.log({
                    clients,
                    username,
                    socketId: socket.id,
                    email,
                    photoURL,
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

        app.delete('/room/:id', async (req, res) => {
            try {
                const id = req.params._id;
                const filter = { _id: new ObjectId(id) };
                const result = await roomsCollection.deleteOne(filter);

                if (result.deletedCount === 1) {
                    res.status(200).json({ message: 'Room deleted successfully' });
                } else {
                    res.status(404).json({ message: 'Room not found' });
                }
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: 'Internal server error' });
            }
        });


        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");


        app.get('/', (req, res) => {
            res.send('Hello World!');
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


