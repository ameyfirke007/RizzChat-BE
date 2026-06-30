require("dotenv").config();

let express = require("express");
let cors = require("cors");
let http = require("http");
let { Server } = require("socket.io");
let { ObjectId } = require("mongodb");

let { messageCollec, photoCollec } = require("./config/db");
let { upload, cloudinary } = require("./config/cloudinary");

let app = express();
app.use(express.json());
app.use(cors());

app.post("/upload",upload.single("file"),(req,res)=>{
  let obj ={
    username : req.body.username,
    caption : req.body.caption,
    file_url : req.file.path,
    file_name : req.file.filename,
    likes: [],
    comments: []
  }

  photoCollec.insertOne(obj)
  .then((result)=>res.send(result))
  .catch((err)=>res.send(err))
})

app.get("/files",(req,res)=>{
  photoCollec.find().toArray()
  .then((result)=>res.send(result))
  .catch((err)=>res.send(err))
})

app.delete("/delete/:id",(req,res)=>{
  let id=req.params.id;
  let _id=new ObjectId(id);
  photoCollec.findOne({_id})
  .then((obj)=>{
    if (obj) {
      cloudinary.uploader.destroy(obj.file_name);
      return photoCollec.deleteOne({_id});
    }
  })
  .then((result)=>res.send(result))
  .catch((err)=>res.send(err))
})

// Likes API
app.put("/files/:id/like", (req, res) => {
  let id = req.params.id;
  let username = req.body.username;
  if (!username) {
    return res.status(400).send({ error: "Username is required" });
  }
  let _id = new ObjectId(id);
  photoCollec.findOne({ _id })
    .then((obj) => {
      if (!obj) return res.status(404).send({ error: "Photo not found" });
      let likes = obj.likes || [];
      let updateOp = likes.includes(username) 
        ? { $pull: { likes: username } } 
        : { $addToSet: { likes: username } };
      
      return photoCollec.updateOne({ _id }, updateOp)
        .then(() => photoCollec.findOne({ _id }))
        .then((updatedObj) => res.send({ success: true, likes: updatedObj.likes || [] }));
    })
    .catch((err) => res.status(500).send(err));
});

// Comments API
app.post("/files/:id/comment", (req, res) => {
  let id = req.params.id;
  let { username, text } = req.body;
  if (!username || !text) {
    return res.status(400).send({ error: "Username and text are required" });
  }
  let _id = new ObjectId(id);
  let comment = {
    _id: new ObjectId(),
    username,
    text,
    createdAt: new Date()
  };
  photoCollec.updateOne({ _id }, { $push: { comments: comment } })
    .then(() => photoCollec.findOne({ _id }))
    .then((updatedObj) => res.send({ success: true, comments: updatedObj.comments || [] }))
    .catch((err) => res.status(500).send(err));
});

app.delete("/files/:id/comment/:commentId", (req, res) => {
  let id = req.params.id;
  let commentId = req.params.commentId;
  let _id = new ObjectId(id);
  let _commentId = new ObjectId(commentId);
  photoCollec.updateOne({ _id }, { $pull: { comments: { _id: _commentId } } })
    .then(() => photoCollec.findOne({ _id }))
    .then((updatedObj) => res.send({ success: true, comments: updatedObj.comments || [] }))
    .catch((err) => res.status(500).send(err));
});

let httpServer = http.createServer(app);
let io = new Server(httpServer, { cors: { origin: "*" } });

let activeUsers = new Map(); // socket.id -> email

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("registerUser", (email) => {
    if (email) {
      activeUsers.set(socket.id, email);
      io.emit("onlineUsers", Array.from(new Set(activeUsers.values())));
    }
  });

  socket.on("getHistory",()=>{
    messageCollec.find().toArray()
    .then((result)=>socket.emit("history",result))
    .catch((err)=>console.log(err))
  })

  socket.on("message", (data) => {
    messageCollec.insertOne(data)
    .then((result)=>{
      data._id = result.insertedId;
      io.emit("message", data);
    })
    .catch((err)=>console.log(err))
  });

  // Typing events
  socket.on("typing", (username) => {
    socket.broadcast.emit("typing", username);
  });

  socket.on("stopTyping", (username) => {
    socket.broadcast.emit("stopTyping", username);
  });

  // Emoji Reactions
  socket.on("reactMessage", ({ messageId, emoji, username }) => {
    if (!messageId || !emoji || !username) return;
    let _id = new ObjectId(messageId);
    messageCollec.findOne({ _id })
    .then((msg) => {
      if (!msg) return;
      let reactions = msg.reactions || {};
      let users = reactions[emoji] || [];
      if (users.includes(username)) {
        users = users.filter((u) => u !== username);
      } else {
        users.push(username);
      }
      
      if (users.length === 0) {
        delete reactions[emoji];
      } else {
        reactions[emoji] = users;
      }
      
      return messageCollec.updateOne({ _id }, { $set: { reactions } })
      .then(() => {
        io.emit("messageReacted", { messageId, reactions });
      });
    })
    .catch((err) => console.log("Reaction error:", err));
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    activeUsers.delete(socket.id);
    io.emit("onlineUsers", Array.from(new Set(activeUsers.values())));
  });
});

httpServer.listen(3000, () => console.log("Server is alive at 3000"));