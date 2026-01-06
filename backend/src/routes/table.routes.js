const express = require('express');
const router = express.Router();
const tableController = require('../controllers/table.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', tableController.getTables);
router.get('/availability', tableController.getTableAvailability);
router.get('/:id', tableController.getTableById);
router.post('/', authorize('admin'), tableController.createTable);
router.put('/:id', authorize('admin'), tableController.updateTable);
router.patch('/:id/status', authorize('waiter', 'admin'), tableController.updateTableStatus);
router.delete('/:id', authorize('admin'), tableController.deleteTable);

module.exports = router;