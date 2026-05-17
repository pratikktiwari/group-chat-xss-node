const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Configure multer for image uploads (5MB limit)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + ext;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(jpeg|jpg|png|gif|webp)$/;
    if (allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, gif, webp) are allowed'));
    }
  }
});


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

// Set up tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'group',
      name TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (conversation_id, username)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL DEFAULT 1,
      username TEXT NOT NULL,
      message TEXT,
      image_url TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS last_read (
      username TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      last_read_message_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (username, conversation_id)
    )
  `);

  // Auto-create the "Community" conversation (id=1) if it doesn't exist
  db.get('SELECT id FROM conversations WHERE id = 1', (err, row) => {
    if (!row) {
      db.run("INSERT INTO conversations (id, type, name, created_by) VALUES (1, 'group', 'Community', 'system')");
    }
  });

  // Ensure all existing users are members of Community
  db.all('SELECT username FROM users', (err, rows) => {
    if (!err && rows) {
      rows.forEach((r) => {
        db.run('INSERT OR IGNORE INTO conversation_members (conversation_id, username) VALUES (1, ?)', [r.username]);
      });
    }
  });
});

// Middleware to parse JSON and form data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files (like HTML, CSS, JS) from the 'public' folder
app.use(express.static('public'));

app.use(cors()); 

// Session middleware — httpOnly is false so XSS can access document.cookie (intentional for demo)
app.use(session({
  secret: 'xss-demo-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: false,
    secure: false,
    sameSite: 'lax'
  }
}));

// Create an HTTP server and pass it to Socket.IO
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// Serve static files from the 'client' folder
app.use(express.static(path.join(__dirname, 'client')));

// Serve uploaded images
app.use('/uploads', express.static(uploadsDir));

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

app.get('/clear-community', (req, res) => {
    db.run('DELETE FROM messages WHERE conversation_id = 1', (err) => {
      if (err) {
        console.error(err);
        res.status(500).send('Failed to clear community messages');
        return;
      }
      res.status(200).send('Community messages cleared');
    });
});

app.get('/clear-private', (req, res) => {
    db.run("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'private')", (err) => {
      if (err) {
        console.error(err);
        res.status(500).send('Failed to clear private messages');
        return;
      }
      res.status(200).send('Private messages cleared');
    });
});

app.get('/clear-groups', (req, res) => {
    db.run("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'group')", (err) => {
      if (err) {
        console.error(err);
        res.status(500).send('Failed to clear group messages');
        return;
      }
      res.status(200).send('Group messages cleared');
    });
});

app.get('/clear', (req, res) => {
    // Delete uploaded files
    if (fs.existsSync(uploadsDir)) {
      fs.readdirSync(uploadsDir).forEach((file) => {
        fs.unlinkSync(path.join(uploadsDir, file));
      });
    }
    db.serialize(() => {
      db.run('DELETE FROM messages');
      db.run('DELETE FROM conversation_members');
      db.run('DELETE FROM last_read');
      db.run('DELETE FROM conversations');
      db.run('DELETE FROM users');
      // Re-create Community group
      db.run("INSERT INTO conversations (id, type, name, created_by) VALUES (1, 'group', 'Community', 'system')", (err) => {
        if (err) {
          res.status(500).send('Failed to clear');
          return;
        }
        res.status(200).send('All data cleared');
      });
    });
});

app.get('/reset-db', (req, res) => {
    // Delete uploaded files
    if (fs.existsSync(uploadsDir)) {
      fs.readdirSync(uploadsDir).forEach((file) => {
        fs.unlinkSync(path.join(uploadsDir, file));
      });
    }
    db.serialize(() => {
      db.run('DROP TABLE IF EXISTS messages');
      db.run('DROP TABLE IF EXISTS conversation_members');
      db.run('DROP TABLE IF EXISTS last_read');
      db.run('DROP TABLE IF EXISTS conversations');
      db.run('DROP TABLE IF EXISTS users');
      // Recreate all tables with current schema
      db.run(`CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL DEFAULT 'group',
        name TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(`CREATE TABLE conversation_members (
        conversation_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        PRIMARY KEY (conversation_id, username)
      )`);
      db.run(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL DEFAULT 1,
        username TEXT NOT NULL,
        message TEXT,
        image_url TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      )`);
      db.run(`CREATE TABLE last_read (
        username TEXT NOT NULL,
        conversation_id INTEGER NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (username, conversation_id)
      )`);
      db.run("INSERT INTO conversations (id, type, name, created_by) VALUES (1, 'group', 'Community', 'system')", (err) => {
        if (err) {
          res.status(500).send('Failed to reset database');
          return;
        }
        res.status(200).send('Database fully reset with fresh schema');
      });
    });
});

app.get('/save', (req, res) => {
    const {data} = req.query;
    console.log("QUERY", req.query);
    // Insert message into database (without sanitizing input, for XSS demo)
    const query = 'INSERT INTO messages (username, message) VALUES (?, ?)';
    db.run(query, ['root', data], function (err) {
      if (err) {
        console.error(err);
        res.status(500).send('Failed to save message');
        return;
      }
      // io.emit('new message', { username, message });
      res.status(200).send('Message saved');
    });
});

// Signup endpoint — creates a new user
app.post('/signup', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  db.run('INSERT INTO users (name, username, password) VALUES (?, ?, ?)', [name, username, password], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      return res.status(500).json({ error: 'Failed to create account' });
    }
    // Auto-add new user to the Community conversation
    db.run('INSERT OR IGNORE INTO conversation_members (conversation_id, username) VALUES (1, ?)', [username]);
    res.json({ success: true });
  });
});

// Login endpoint — authenticates existing user
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Server error' });
    }
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    req.session.username = username;
    res.json({ username });
  });
});

// Check current session — useful to verify session hijacking
app.get('/me', (req, res) => {
  if (req.session && req.session.username) {
    return res.json({ username: req.session.username });
  }
  res.status(401).json({ error: 'Not logged in' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// List all users (for sidebar + group creation)
app.get('/api/users', (req, res) => {
  db.all('SELECT username, name FROM users ORDER BY name ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    res.json(rows);
  });
});

// List conversations for the logged-in user (with last message info)
app.get('/api/conversations', (req, res) => {
  if (!req.session || !req.session.username) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const username = req.session.username;
  const query = `
    SELECT c.id, c.type, c.name, c.created_by,
      m.message AS last_message, m.username AS last_message_by, m.timestamp AS last_message_at,
      (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id
        AND msg.id > COALESCE((SELECT last_read_message_id FROM last_read WHERE username = ? AND conversation_id = c.id), 0)
      ) AS unread_count
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.username = ?
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE conversation_id = c.id ORDER BY timestamp DESC LIMIT 1
    )
    ORDER BY m.timestamp DESC NULLS LAST, c.name ASC
  `;
  db.all(query, [username, username], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Server error' });

    // For private chats, include the other user's info
    const enriched = [];
    let pending = rows.length;
    if (pending === 0) return res.json([]);

    rows.forEach((row) => {
      if (row.type === 'private') {
        db.get(
          'SELECT username, name FROM users WHERE username = (SELECT username FROM conversation_members WHERE conversation_id = ? AND username != ?)',
          [row.id, username],
          (err2, otherUser) => {
            row.other_user = otherUser || null;
            enriched.push(row);
            if (--pending === 0) res.json(enriched);
          }
        );
      } else {
        enriched.push(row);
        if (--pending === 0) res.json(enriched);
      }
    });
  });
});

// Create a conversation (group or private)
app.post('/api/conversations', (req, res) => {
  if (!req.session || !req.session.username) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const { type, name, members } = req.body;
  const creator = req.session.username;

  if (type === 'private') {
    // For private chats, check if one already exists between these two users
    const otherUser = members && members[0];
    if (!otherUser) return res.status(400).json({ error: 'Member required' });

    db.get(
      `SELECT c.id FROM conversations c
       WHERE c.type = 'private'
       AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND username = ?)
       AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND username = ?)`,
      [creator, otherUser],
      (err, existing) => {
        if (err) return res.status(500).json({ error: 'Server error' });
        if (existing) return res.json({ id: existing.id, existing: true });

        db.run("INSERT INTO conversations (type, created_by) VALUES ('private', ?)", [creator], function (err2) {
          if (err2) return res.status(500).json({ error: 'Failed to create conversation' });
          const convId = this.lastID;
          db.run('INSERT INTO conversation_members VALUES (?, ?)', [convId, creator]);
          db.run('INSERT INTO conversation_members VALUES (?, ?)', [convId, otherUser], () => {
            res.json({ id: convId, existing: false });
          });
        });
      }
    );
  } else if (type === 'group') {
    if (!name) return res.status(400).json({ error: 'Group name required' });
    if (!members || members.length === 0) return res.status(400).json({ error: 'Members required' });

    db.run("INSERT INTO conversations (type, name, created_by) VALUES ('group', ?, ?)", [name, creator], function (err) {
      if (err) return res.status(500).json({ error: 'Failed to create group' });
      const convId = this.lastID;
      const allMembers = [...new Set([creator, ...members])];
      let pending = allMembers.length;
      allMembers.forEach((m) => {
        db.run('INSERT OR IGNORE INTO conversation_members VALUES (?, ?)', [convId, m], () => {
          if (--pending === 0) res.json({ id: convId });
        });
      });
    });
  } else {
    res.status(400).json({ error: 'Invalid conversation type' });
  }
});

// Get members of a conversation
app.get('/api/conversations/:id/members', (req, res) => {
  const convId = req.params.id;
  db.get('SELECT id, type, name, created_by FROM conversations WHERE id = ?', [convId], (err, conv) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!conv) return res.status(404).json({ error: 'Not found' });

    db.all(
      'SELECT cm.username, u.name FROM conversation_members cm LEFT JOIN users u ON u.username = cm.username WHERE cm.conversation_id = ?',
      [convId],
      (err2, members) => {
        if (err2) return res.status(500).json({ error: 'Server error' });
        res.json({ conversation: conv, members });
      }
    );
  });
});

// Mark conversation as read
app.post('/api/conversations/:id/read', (req, res) => {
  if (!req.session || !req.session.username) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const convId = req.params.id;
  const username = req.session.username;

  db.get('SELECT MAX(id) as maxId FROM messages WHERE conversation_id = ?', [convId], (err, row) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    const maxId = (row && row.maxId) || 0;
    db.run(
      'INSERT OR REPLACE INTO last_read (username, conversation_id, last_read_message_id) VALUES (?, ?, ?)',
      [username, convId, maxId],
      (err2) => {
        if (err2) return res.status(500).json({ error: 'Server error' });
        res.json({ success: true });
      }
    );
  });
});

// Upload image endpoint
app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, function (err) {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large. Maximum size is 5MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const { conversationId, username, message } = req.body;
    if (!conversationId || !username) {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'conversationId and username are required' });
    }

    const imageUrl = '/uploads/' + req.file.filename;
    const caption = message || '';

    db.run(
      'INSERT INTO messages (conversation_id, username, message, image_url) VALUES (?, ?, ?, ?)',
      [conversationId, username, caption, imageUrl],
      function (dbErr) {
        if (dbErr) {
          console.error(dbErr);
          return res.status(500).json({ error: 'Failed to save message' });
        }
        const msgData = {
          conversationId: parseInt(conversationId),
          username,
          message: caption,
          image_url: imageUrl,
          timestamp: new Date().toISOString()
        };
        io.to('conv:' + conversationId).emit('new message', msgData);
        io.to('conv:' + conversationId).emit('conversation updated', { conversationId: parseInt(conversationId) });
        res.json({ success: true, image_url: imageUrl });
      }
    );
  });
});

// When a new socket connects
io.on('connection', (socket) => {
  console.log('New user connected');

  // User joins all their conversation rooms
  socket.on('join conversations', (username) => {
    db.all('SELECT conversation_id FROM conversation_members WHERE username = ?', [username], (err, rows) => {
      if (err) return;
      rows.forEach((row) => {
        socket.join('conv:' + row.conversation_id);
      });
    });
  });

  // Load messages for a specific conversation
  socket.on('load messages', (conversationId) => {
    db.all(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
      [conversationId],
      (err, rows) => {
        if (err) return;
        socket.emit('chat messages', { conversationId, messages: rows });
      }
    );
  });

  // When a user sends a message
  socket.on('new message', (msg) => {
    const { username, message, conversationId } = msg;

    if (!username || !message || !conversationId) {
      return;
    }

    // Insert message into database (without sanitizing input, for XSS demo)
    const query = 'INSERT INTO messages (conversation_id, username, message) VALUES (?, ?, ?)';
    db.run(query, [conversationId, username, message], function (err) {
      if (err) {
        console.error(err);
        return;
      }

      // Emit the new message only to members of this conversation
      io.to('conv:' + conversationId).emit('new message', { conversationId, username, message, timestamp: new Date().toISOString() });
      // Also emit a sidebar update event so all members can refresh their conversation list
      io.to('conv:' + conversationId).emit('conversation updated', { conversationId });
    });
  });

  // Join a newly created conversation room
  socket.on('join conversation', (conversationId) => {
    socket.join('conv:' + conversationId);
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
