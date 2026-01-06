const express = require('express');
const router = express.Router();
const deliveryController = require('../controllers/reservationDelivery.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', deliveryController.getDeliveries);
router.get('/:id', deliveryController.getDeliveryById);
router.post('/', authorize('cashier', 'admin'), deliveryController.createDelivery);
router.patch('/:id/assign', authorize('cashier', 'admin'), deliveryController.assignDriver);
router.patch('/:id/status', authorize('driver', 'admin'), deliveryController.updateDeliveryStatus);
router.patch('/:id/complete', authorize('driver', 'admin'), deliveryController.completeDelivery);

module.exports = router;