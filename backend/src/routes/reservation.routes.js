const express = require('express');
const router = express.Router();
const reservationController = require('../controllers/reservationDelivery.controller');
const { authenticate, authorize } = require('../middleware/auth');

// Public route for creating reservations (from website)
router.post('/', reservationController.createReservation);

// Protected routes
router.use(authenticate);

router.get('/', reservationController.getReservations);
router.get('/:id', reservationController.getReservationById);
router.patch('/:id/status', authorize('cashier', 'admin'), reservationController.updateReservationStatus);
router.patch('/:id/checkin', authorize('waiter', 'cashier', 'admin'), reservationController.checkinReservation);
router.delete('/:id', authorize('admin'), reservationController.cancelReservation);

module.exports = router;
