const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose(); // Import SQLite3

dotenv.config();

const app = express();
const port = 8080;


// Uncomment for MySQL Database connection
// const db = mysql.createConnection({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASS,
//   database: process.env.DB_NAME
// });

// db.connect(err => {
//   if (err) {
//     console.error('Database connection failed:', err.stack);
//     return;
//   }
//   console.log('Connected to MySQL database.');
// });


// Initialize SQLite database (it will create a new file if it doesn't exist)
const db = new sqlite3.Database('./chat_app.db', (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err);
    return;
  }
  console.log('Connected to SQLite database.');
});

// Set up the table if it doesn't exist already
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Middleware to parse JSON and form data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files (like HTML, CSS, JS) from the 'public' folder
app.use(express.static('public'));

app.use(cors()); 

// Create an HTTP server and pass it to Socket.IO
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// Serve static files from the 'client' folder
app.use(express.static(path.join(__dirname, 'client')));

// Root route to serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

app.get('/clear-chat', (req, res) => {
    // Clear all messages from the database
    db.run('DELETE FROM messages', (err) => {
      if (err) {
        console.error(err);
        res.status(500).send('Failed to clear chat messages');
        return;
      }
      res.status(200).send('Chat messages cleared');
    });
});

// When a new socket connects
io.on('connection', (socket) => {
  console.log('New user connected');
  
  // Send all messages to the newly connected client
  db.all('SELECT * FROM messages ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      console.error(err);
      return;
    }
    socket.emit('chat messages', rows); // Send existing messages to the client
  });

  // When a user sends a message
  socket.on('new message', (msg) => {
    const { username, message } = msg;

    if (!username || !message) {
      return;
    }

    // Insert message into database (without sanitizing input, for XSS demo)
    const query = 'INSERT INTO messages (username, message) VALUES (?, ?)';
    db.run(query, [username, message], function (err) {
      if (err) {
        console.error(err);
        return;
      }

      // Emit the new message to all connected clients
      io.emit('new message', { username, message });
    });
  });

  // When the user disconnects
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Start the server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
