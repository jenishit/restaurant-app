const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.post('/', authorize('cashier', 'admin'), paymentController.processPayment);
router.post('/split', authorize('cashier', 'admin'), paymentController.splitPayment);
router.get('/order/:order_id', paymentController.getPaymentByOrder);
router.post('/:id/refund', authorize('admin'), paymentController.refundPayment);

module.exports = router;