const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { body, validationResult } = require('express-validator');
const pLimit = require('p-limit');

const app = express();

// Configure CORS to allow all origins and methods
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: false
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Initialize the concurrency limit (5 concurrent requests)
const limit = pLimit(5);

// 1. GET Tickets Endpoint
app.get('/tickets', async (req, res) => {
    try {
        const response = await axios.get(process.env.JIRA_GET_API_URL, {
            headers: {
                'Authorization': `Basic ${process.env.JIRA_AUTH_TOKEN}`,
                'Accept': 'application/json'
            }
        });
        res.json(response.data);
        console.log('Received Response Payload:', JSON.stringify(res.json(response.data), null, 2));
    } catch (error) {
        console.error('Error fetching tickets:', error.message);
        res.status(500).json({ error: 'Failed to fetch from Jira' });
    }
});

// 2. POST Subtasks Endpoint - handles ONE subtask at a time
app.post('/subtasks', express.json(), async (req, res) => {
    const { summary, description, parentKey } = req.body;

    console.log("--- Request Received ---");
    console.log("Full Body:", JSON.stringify(req.body, null, 2));

    // Validate required fields
    if (!summary || !description || !parentKey) {
        return res.status(400).json({
            error: 'Missing required fields: summary, description, and parentKey are required'
        });
    }

try {
    const response = await axios.post(
        process.env.JIRA_POST_API_URL,
        {
            fields: {
                project: { key: "INC" }, // Use 'key', not 'id'
                parent: { key: parentKey }, // Use the key passed from your request
                summary: summary,
                description: {
                    type: "doc",
                    version: 1,
                    content: [
                        {
                            type: "paragraph",
                            content: [{ type: "text", text: description }]
                        }
                    ]
                },
                issuetype: { id: "10006" } // Removed the duplicate line
            }
        },
        {
            headers: {
                'Authorization': `Basic ${process.env.JIRA_AUTH_TOKEN}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        }
    );

    res.json({
        success: true,
        key: response.data.key,
        id: response.data.id,
        self: response.data.self
    });

    } catch (error) {
        console.error("Subtask creation failed:", error.response?.data || error.message);
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

