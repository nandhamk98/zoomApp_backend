// const express = require("express");
// const http = require("http");
// const { v4: uuidv4 } = require("uuid");
// const cors = require("cors");
// const twilio = require("twilio");
// const {MongoClient} = require("mongodb"); 
import express  from 'express';
import http from 'http';
import {v4 as uuidv4} from 'uuid';
import cors from 'cors';
import twilio from 'twilio';
import {MongoClient} from 'mongodb';
import { Server } from "socket.io";
import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 5002;
const app = express();
const server = http.createServer(app);

// const url = ''
const url = process.env.MONGO_URL;


const createConnection = async ()=>{
  const client = new MongoClient(url);
  await client.connect();
  console.log("connected to db")
  return client;
}

const client = await createConnection();



const getRoomData = async () => {
  const data = await client.db("Zoom").collection('Room').find({}).toArray();
  return data;
}

const insertRoomData = async (data) => {
  const response = await client.db("Zoom").collection('Room').insertOne(data);
  return response;
}

const updateRoomData = async (filteredParam, Data) => {
  const response = await client.db("Zoom").collection('Room').updateOne(filteredParam,{$set :Data} );
  return response;
}


const getUserData = async () => {
  const data = await client.db("Zoom").collection('AppUser').find({}).toArray();
  return data
}

const insertUserData = async (data) => {
  const response = await client.db("Zoom").collection('AppUser').insertOne(data);
  return response;
}

const removeUserData = async (data) => {
  const response = await client.db("Zoom").collection('AppUser').deleteOne(data);
  return response;
}


const removeRoomData = async (data) => {
  const response = await client.db("Zoom").collection('Room').deleteOne(data);
}
app.use(cors());

// let connectedUsers = [];
// let rooms = [];

// create route to check if room exists
app.get("/api/room-exists/:roomId", async (req, res) => {
  const { roomId } = req.params;
  const rooms = await getRoomData();
  const room = rooms.find((room) => room.id === roomId);

  if (room) {
    // send reponse that room exists
    if (room.connectedUsers.length > 3) {
      return res.send({ roomExists: true, full: true });
    } else {
      return res.send({ roomExists: true, full: false });
    }
  } else {
    // send response that room does not exists
    return res.send({ roomExists: false });
  }
});

app.get("/api/get-turn-credentials", (req, res) => {
  const accountSid = process.env.ACCOUNT_SECRET_KEY
  const authToken = process.env.AUTH_TOKEN;

  const client = twilio(accountSid, authToken);

  res.send({ token: null });
  try {
    client.tokens.create().then((token) => {
      res.send({ token });
    });
  } catch (err) {
    console.log("error occurred when fetching turn server credentials");
    console.log(err);
    res.send({ token: null });
  }
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`user connected ${socket.id}`);

  socket.on("create-new-room", (data) => {
    createNewRoomHandler(data, socket);
  });

  socket.on("join-room", (data) => {
    joinRoomHandler(data, socket);
  });

  socket.on("disconnect", () => {
    disconnectHandler(socket);
  });

  socket.on("conn-signal", (data) => {
    signalingHandler(data, socket);
  });

  socket.on("conn-init", (data) => {
    initializeConnectionHandler(data, socket);
  });

  socket.on("direct-message", (data) => {
    directMessageHandler(data, socket);
  });
});

// socket.io handlers

const createNewRoomHandler = async (data, socket) => {
  const rooms = await getRoomData();
  console.log("host is creating new room");
  // console.log(data);
  const { identity, onlyAudio } = data;

  const roomId = uuidv4();

  // create new user
  const newUser = {
    identity,
    id: uuidv4(),
    socketId: socket.id,
    roomId,
    onlyAudio,
  };

  // push that user to connectedUsers
  let connectedUsers = [ newUser];

  await insertUserData(newUser);
  //create new room
  const newRoom = {
    id: roomId,
    connectedUsers: [newUser],
  };
  // join socket.io room
  socket.join(roomId);

  const roomInsert = await insertRoomData(newRoom);

  // emit to that client which created that room roomId
  socket.emit("room-id", { roomId });
  // console.log(rooms);
  // console.log(connectedUsers)

  // emit an event to all users connected
  // to that room about new users which are right in this room
  socket.emit("room-update", { connectedUsers: newRoom.connectedUsers });
};

const joinRoomHandler = async (data, socket) => {
  const { identity, roomId, onlyAudio } = data;

  const newUser = {
    identity,
    id: uuidv4(),
    socketId: socket.id,
    roomId,
    onlyAudio,
  };

  // join room as user which just is trying to join room passing room id
  const rooms = await getRoomData();
  await insertUserData(newUser);
  const room = rooms.find((room) => room.id === roomId);
  if(room){
    let connectedUsers = [...room.connectedUsers, newUser]

    let updateConnectUser ={
      connectedUsers }
    await updateRoomData({id: room.id},updateConnectUser)

    // join socket.io room
    socket.join(roomId);

    // add new user to connected users array
    connectedUsers = [...connectedUsers, newUser];
  
    // emit to all users which are already in this room to prepare peer connection
    connectedUsers.forEach((user) => {
      if (user.socketId !== socket.id) {
        const data = {
          connUserSocketId: socket.id,
        };
  
        io.to(user.socketId).emit("conn-prepare", data);
      }
    });
  
    io.to(roomId).emit("room-update", { connectedUsers: room.connectedUsers });
  }
  


 
};

const disconnectHandler = async (socket) => {
  // find if user has been registered - if yes remove him from room and connected users array
  const connectedUsers = await getUserData();
  const user = connectedUsers.find((user) => user.socketId === socket.id);

  if (user) {
    // remove user from room in server
    const rooms = await getRoomData();
    const room = rooms.find((room) => room.id === user.roomId);

    let remainingconnectedUsers = room.connectedUsers.filter(
      (userProfile) => userProfile.socketId !== socket.id
    );

    // console.log(remainingconnectedUsers)
    // leave socket io room
    socket.leave(user.roomId);
    await removeUserData({socketId: socket.id})

    let val = await updateRoomData({id: room.id},{connectedUsers : remainingconnectedUsers})

    // close the room if amount of the users which will stay in room will be 0
    if (remainingconnectedUsers.length > 0) {
      // emit to all users which are still in the room that user disconnected
      io.to(room.id).emit("user-disconnected", { socketId: socket.id });

      // emit an event to rest of the users which left in the toom new connectedUsers in room
      io.to(room.id).emit("room-update", {
        connectedUsers: remainingconnectedUsers,
      });
    } else {
      await removeRoomData({id: room.id});
    }
  }
};

const signalingHandler = (data, socket) => {
  const { connUserSocketId, signal } = data;

  const signalingData = { signal, connUserSocketId: socket.id };
  io.to(connUserSocketId).emit("conn-signal", signalingData);
};

// information from clients which are already in room that They have preapred for incoming connection
const initializeConnectionHandler = (data, socket) => {
  const { connUserSocketId } = data;

  const initData = { connUserSocketId: socket.id };
  io.to(connUserSocketId).emit("conn-init", initData);
};

const directMessageHandler = (data, socket) => {
  if (
    connectedUsers.find(
      (connUser) => connUser.socketId === data.receiverSocketId
    )
  ) {
    const receiverData = {
      authorSocketId: socket.id,
      messageContent: data.messageContent,
      isAuthor: false,
      identity: data.identity,
    };
    socket.to(data.receiverSocketId).emit("direct-message", receiverData);

    const authorData = {
      receiverSocketId: data.receiverSocketId,
      messageContent: data.messageContent,
      isAuthor: true,
      identity: data.identity,
    };

    socket.emit("direct-message", authorData);
  }
};

server.listen(PORT, () => {
  console.log(`Server is listening on ${PORT}`);
});
