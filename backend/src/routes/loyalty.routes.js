const express = require('express');
const router = express.Router();
const loyaltyController = require('../controllers/couponLoyalty.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/customers/:phone', loyaltyController.getCustomerLoyalty);
router.post('/customers', loyaltyController.enrollCustomer);
router.post('/redeem', authorize('cashier', 'admin'), loyaltyController.redeemReward);
router.get('/customers/:id/transactions', loyaltyController.getLoyaltyTransactions);

module.exports = router;