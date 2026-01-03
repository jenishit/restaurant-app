const express = require('express');
const router = express.Router();

// Routes will be implemented
router.get('/', (req, res) => {
  res.json({ success: true, message: 'Route working' });
});

module.exports = router;