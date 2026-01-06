const express = require('express');
const router = express.Router();
const reportController = require('../controllers/report.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin', 'cashier')); // Only admin and cashier can view reports

router.get('/dashboard', reportController.getDashboardSummary);
router.get('/sales/daily', reportController.getDailySalesReport);
router.get('/revenue', reportController.getRevenueReport);
router.get('/items/performance', reportController.getItemPerformanceReport);
router.get('/waiters/performance', reportController.getWaiterPerformanceReport);
router.get('/inventory/alerts', reportController.getInventoryAlertReport);
router.get('/customers/analytics', reportController.getCustomerAnalytics);

module.exports = router;