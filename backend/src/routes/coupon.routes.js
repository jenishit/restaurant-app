const express = require('express');
const router = express.Router();
const couponController = require('../controllers/couponLoyalty.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', authorize('admin'), couponController.getCoupons);
router.post('/', authorize('admin'), couponController.createCoupon);
router.put('/:id', authorize('admin'), couponController.updateCoupon);
router.post('/validate', couponController.validateCoupon);
router.delete('/:id', authorize('admin'), couponController.deleteCoupon);

module.exports = router;