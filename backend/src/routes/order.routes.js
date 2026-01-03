const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { authenticate, authorize } = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/v1/orders
 * @desc    Create new order
 * @access  Waiter, Cashier, Admin
 */
router.post('/', 
  authorize('waiter', 'cashier', 'admin'),
  orderController.createOrder
);

/**
 * @route   GET /api/v1/orders
 * @desc    Get all orders with filters
 * @access  All authenticated users
 */
router.get('/', orderController.getOrders);

/**
 * @route   GET /api/v1/orders/:id
 * @desc    Get order by ID
 * @access  All authenticated users
 */
router.get('/:id', orderController.getOrderById);

/**
 * @route   PATCH /api/v1/orders/:id/status
 * @desc    Update order status
 * @access  Waiter, Kitchen, Admin
 */
router.patch('/:id/status',
  authorize('waiter', 'kitchen', 'admin'),
  orderController.updateOrderStatus
);

/**
 * @route   POST /api/v1/orders/:id/items
 * @desc    Add items to existing order
 * @access  Waiter, Admin
 */
router.post('/:id/items',
  authorize('waiter', 'admin'),
  orderController.addItemsToOrder
);

/**
 * @route   DELETE /api/v1/orders/:id/items/:item_id
 * @desc    Void/remove order item
 * @access  Waiter (before confirmation), Admin (after confirmation)
 */
router.delete('/:id/items/:item_id',
  authorize('waiter', 'admin'),
  orderController.voidOrderItem
);

/**
 * @route   PATCH /api/v1/orders/:id/transfer
 * @desc    Transfer order to different table
 * @access  Waiter, Admin
 */
router.patch('/:id/transfer',
  authorize('waiter', 'admin'),
  orderController.transferOrder
);

/**
 * @route   DELETE /api/v1/orders/:id
 * @desc    Cancel order
 * @access  Admin only
 */
router.delete('/:id',
  authorize('admin'),
  orderController.cancelOrder
);

module.exports = router;