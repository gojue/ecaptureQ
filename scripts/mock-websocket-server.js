#!/usr/bin/env node

/**
 * Simple WebSocket server that sends mock HTTP packet data
 * This is for testing the EcaptureQ application
 */

import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

console.log('Mock WebSocket server started on ws://localhost:8080');

// Mock HTTP request data
const mockRequests = [
  {
    method: 'GET',
    url: '/api/users',
    headers: {
      'Host': 'api.example.com',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIs...'
    }
  },
  {
    method: 'POST',
    url: '/api/users',
    headers: {
      'Host': 'api.example.com',
      'Content-Type': 'application/json',
      'Content-Length': '156'
    },
    body: JSON.stringify({
      name: 'John Doe',
      email: 'john@example.com',
      role: 'admin'
    })
  },
  {
    method: 'PUT',
    url: '/api/users/123',
    headers: {
      'Host': 'api.example.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Jane Doe',
      email: 'jane@example.com'
    })
  }
];

// Mock HTTP response data
const mockResponses = [
  {
    statusCode: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '245',
      'Server': 'nginx/1.18.0'
    },
    body: JSON.stringify({
      users: [
        { id: 1, name: 'John Doe', email: 'john@example.com' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com' }
      ]
    })
  },
  {
    statusCode: 201,
    statusText: 'Created',
    headers: {
      'Content-Type': 'application/json',
      'Location': '/api/users/124'
    },
    body: JSON.stringify({
      id: 124,
      name: 'John Doe',
      email: 'john@example.com',
      role: 'admin'
    })
  },
  {
    statusCode: 404,
    statusText: 'Not Found',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      error: 'User not found',
      code: 'USER_NOT_FOUND'
    })
  }
];

function generateHttpRequestString(req) {
  let httpString = `${req.method} ${req.url} HTTP/1.1\r\n`;
  
  for (const [key, value] of Object.entries(req.headers)) {
    httpString += `${key}: ${value}\r\n`;
  }
  
  httpString += '\r\n';
  
  if (req.body) {
    httpString += req.body;
  }
  
  return httpString;
}

function generateHttpResponseString(res) {
  let httpString = `HTTP/1.1 ${res.statusCode} ${res.statusText}\r\n`;
  
  for (const [key, value] of Object.entries(res.headers)) {
    httpString += `${key}: ${value}\r\n`;
  }
  
  httpString += '\r\n';
  
  if (res.body) {
    httpString += res.body;
  }
  
  return httpString;
}

function sendRandomPacket(ws) {
  const isRequest = Math.random() > 0.5;
  
  let httpString;
  if (isRequest) {
    const randomReq = mockRequests[Math.floor(Math.random() * mockRequests.length)];
    httpString = generateHttpRequestString(randomReq);
  } else {
    const randomRes = mockResponses[Math.floor(Math.random() * mockResponses.length)];
    httpString = generateHttpResponseString(randomRes);
  }
  
  // Encode to base64
  const base64Data = Buffer.from(httpString).toString('base64');
  
  // Send as JSON
  const message = {
    httpData: base64Data,
    timestamp: Date.now()
  };
  
  try {
    ws.send(JSON.stringify(message));
  } catch (error) {
    console.error('Failed to send message:', error);
  }
}

wss.on('connection', function connection(ws) {
  console.log('Client connected');
  
  // Send initial packet immediately
  sendRandomPacket(ws);
  
  // Send packets every 2-5 seconds
  const interval = setInterval(() => {      if (ws.readyState === 1) { // WebSocket.OPEN
        sendRandomPacket(ws);
      } else {
        clearInterval(interval);
      }
    }, 2000 + Math.random() * 3000);
  
  ws.on('close', function() {
    console.log('Client disconnected');
    clearInterval(interval);
  });
  
  ws.on('error', function(error) {
    console.error('WebSocket error:', error);
    clearInterval(interval);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down WebSocket server...');
  wss.close(() => {
    console.log('WebSocket server closed');
    process.exit(0);
  });
});

console.log('Mock data will be sent to connected clients every 2-5 seconds');
console.log('Press Ctrl+C to stop the server');
