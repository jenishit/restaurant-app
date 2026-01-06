const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// RESERVATION SYSTEM
// ============================================

/**
 * Create reservation
 * POST /api/v1/reservations
 */
const createReservation = async (req, res) => {
  try {
    const {
      location_id,
      customer_name,
      customer_phone,
      customer_email,
      reservation_date,
      reservation_time,
      party_size,
      special_requests,
    } = req.body;

    if (!location_id || !customer_name || !customer_phone || !reservation_date || !reservation_time || !party_size) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
        },
      });
    }

    // Check if customer exists
    let customer = await prisma.customer.findUnique({
      where: { phone: customer_phone },
    });

    const reservation = await prisma.reservation.create({
      data: {
        locationId: location_id,
        customerId: customer?.id,
        customerName: customer_name,
        customerPhone: customer_phone,
        customerEmail: customer_email,
        reservationDate: new Date(reservation_date),
        reservationTime: reservation_time,
        partySize: party_size,
        specialRequests: special_requests,
        status: 'pending',
        createdBy: req.user?.id,
      },
    });

    logger.info(`Reservation created: ${reservation.id} for ${customer_name} on ${reservation_date}`);

    res.status(201).json({
      success: true,
      data: {
        ...reservation,
        reservation_number: `RES-${reservation.reservationDate.toISOString().split('T')[0].replace(/-/g, '')}-${String(reservation.id).slice(-4).padStart(4, '0')}`,
      },
    });
  } catch (error) {
    logger.error('Create reservation error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create reservation',
      },
    });
  }
};

/**
 * Get all reservations
 * GET /api/v1/reservations
 */
const getReservations = async (req, res) => {
  try {
    const { location_id, date, status } = req.query;

    const where = {};
    if (location_id) where.locationId = location_id;
    if (status) where.status = status;
    
    if (date) {
      where.reservationDate = new Date(date);
    }

    // Non-admin users can only see their location
    if (req.user.role !== 'admin' && req.user.locationId) {
      where.locationId = req.user.locationId;
    }

    const reservations = await prisma.reservation.findMany({
      where,
      orderBy: [
        { reservationDate: 'asc' },
        { reservationTime: 'asc' },
      ],
      include: {
        table: {
          select: {
            id: true,
            tableNumber: true,
          },
        },
        customer: {
          select: {
            loyaltyTier: true,
            totalOrders: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: reservations,
    });
  } catch (error) {
    logger.error('Get reservations error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch reservations',
      },
    });
  }
};

/**
 * Get reservation by ID
 * GET /api/v1/reservations/:id
 */
const getReservationById = async (req, res) => {
  try {
    const { id } = req.params;

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        location: {
          select: {
            name: true,
            address: true,
            phone: true,
          },
        },
        table: true,
        customer: true,
      },
    });

    if (!reservation) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Reservation not found',
        },
      });
    }

    res.json({
      success: true,
      data: reservation,
    });
  } catch (error) {
    logger.error('Get reservation error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch reservation',
      },
    });
  }
};

/**
 * Update reservation status
 * PATCH /api/v1/reservations/:id/status
 */
const updateReservationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, table_id } = req.body;

    const validStatuses = ['pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        },
      });
    }

    const updateData = { status };

    if (status === 'confirmed' && table_id) {
      updateData.tableId = table_id;
      updateData.assignedTableAt = new Date();
    }

    if (status === 'seated') {
      updateData.checkedInAt = new Date();
    }

    if (status === 'completed') {
      updateData.completedAt = new Date();
    }

    if (status === 'cancelled') {
      updateData.cancelledAt = new Date();
      updateData.cancellationReason = req.body.cancellation_reason;
    }

    const reservation = await prisma.reservation.update({
      where: { id },
      data: updateData,
      include: {
        table: {
          select: {
            tableNumber: true,
          },
        },
      },
    });

    logger.info(`Reservation ${id} status updated to ${status}`);

    res.json({
      success: true,
      data: reservation,
    });
  } catch (error) {
    logger.error('Update reservation status error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update reservation status',
      },
    });
  }
};

/**
 * Check-in reservation
 * PATCH /api/v1/reservations/:id/checkin
 */
const checkinReservation = async (req, res) => {
  try {
    const { id } = req.params;
    const { table_id } = req.body;

    const reservation = await prisma.reservation.findUnique({
      where: { id },
    });

    if (!reservation) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Reservation not found',
        },
      });
    }

    if (reservation.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'RESERVATION_CANCELLED',
          message: 'Cannot check in cancelled reservation',
        },
      });
    }

    // Update reservation and table in transaction
    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id },
        data: {
          status: 'seated',
          tableId: table_id,
          checkedInAt: new Date(),
        },
      });

      if (table_id) {
        await tx.table.update({
          where: { id: table_id },
          data: {
            status: 'occupied',
          },
        });
      }
    });

    logger.info(`Reservation ${id} checked in at table ${table_id}`);

    res.json({
      success: true,
      data: {
        id,
        status: 'seated',
        checked_in_at: new Date(),
      },
    });
  } catch (error) {
    logger.error('Check-in reservation error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to check in reservation',
      },
    });
  }
};

/**
 * Cancel reservation
 * DELETE /api/v1/reservations/:id
 */
const cancelReservation = async (req, res) => {
  try {
    const { id } = req.params;
    const { cancellation_reason } = req.body;

    await prisma.reservation.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: cancellation_reason,
      },
    });

    logger.info(`Reservation cancelled: ${id}`);

    res.json({
      success: true,
      message: 'Reservation cancelled successfully',
    });
  } catch (error) {
    logger.error('Cancel reservation error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to cancel reservation',
      },
    });
  }
};

// ============================================
// DELIVERY MANAGEMENT
// ============================================

/**
 * Create delivery
 * POST /api/v1/deliveries
 */
const createDelivery = async (req, res) => {
  try {
    const {
      order_id,
      delivery_address,
      delivery_latitude,
      delivery_longitude,
      delivery_instructions,
      delivery_fee,
    } = req.body;

    if (!order_id || !delivery_address || !delivery_fee) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Order ID, delivery address, and fee are required',
        },
      });
    }

    // Check if order exists and is delivery type
    const order = await prisma.order.findUnique({
      where: { id: order_id },
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Order not found',
        },
      });
    }

    if (order.orderType !== 'delivery') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ORDER_TYPE',
          message: 'Order must be delivery type',
        },
      });
    }

    // Calculate distance (mock calculation - in production use Google Maps API)
    const distanceKm = delivery_latitude && delivery_longitude ? 
      Math.random() * 10 + 1 : null;

    // Estimate delivery time (15 min prep + 3 min per km)
    const estimatedMinutes = 15 + (distanceKm ? Math.ceil(distanceKm * 3) : 30);
    const estimatedDeliveryTime = new Date();
    estimatedDeliveryTime.setMinutes(estimatedDeliveryTime.getMinutes() + estimatedMinutes);

    const delivery = await prisma.delivery.create({
      data: {
        orderId: order_id,
        deliveryAddress: delivery_address,
        deliveryLatitude: delivery_latitude,
        deliveryLongitude: delivery_longitude,
        deliveryInstructions: delivery_instructions,
        deliveryFee: delivery_fee,
        distanceKm: distanceKm,
        estimatedDeliveryTime: estimatedDeliveryTime,
        status: 'pending',
      },
    });

    logger.info(`Delivery created for order: ${order.orderNumber}`);

    res.status(201).json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    logger.error('Create delivery error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create delivery',
      },
    });
  }
};

/**
 * Get all deliveries
 * GET /api/v1/deliveries
 */
const getDeliveries = async (req, res) => {
  try {
    const { status, driver_id, date } = req.query;

    const where = {};
    if (status) where.status = status;
    if (driver_id) where.driverId = driver_id;
    
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      where.createdAt = {
        gte: startDate,
        lte: endDate,
      };
    }

    // Drivers can only see their own deliveries
    if (req.user.role === 'driver') {
      where.driverId = req.user.id;
    }

    const deliveries = await prisma.delivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            orderNumber: true,
            customerName: true,
            customerPhone: true,
            total: true,
          },
        },
        driver: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: deliveries,
    });
  } catch (error) {
    logger.error('Get deliveries error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch deliveries',
      },
    });
  }
};

/**
 * Get delivery by ID
 * GET /api/v1/deliveries/:id
 */
const getDeliveryById = async (req, res) => {
  try {
    const { id } = req.params;

    const delivery = await prisma.delivery.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            items: {
              include: {
                menuItem: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
        driver: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
    });

    if (!delivery) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Delivery not found',
        },
      });
    }

    res.json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    logger.error('Get delivery error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch delivery',
      },
    });
  }
};

/**
 * Assign driver to delivery
 * PATCH /api/v1/deliveries/:id/assign
 */
const assignDriver = async (req, res) => {
  try {
    const { id } = req.params;
    const { driver_id } = req.body;

    if (!driver_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Driver ID is required',
        },
      });
    }

    const delivery = await prisma.delivery.update({
      where: { id },
      data: {
        driverId: driver_id,
        status: 'assigned',
        assignedAt: new Date(),
      },
      include: {
        driver: {
          select: {
            name: true,
            phone: true,
          },
        },
        order: true,
      },
    });

    logger.info(`Driver ${driver_id} assigned to delivery ${id}`);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`location:${delivery.order.locationId}`).emit('delivery:driver_assigned', {
      delivery_id: id,
      driver_name: delivery.driver.name,
    });

    res.json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    logger.error('Assign driver error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to assign driver',
      },
    });
  }
};

/**
 * Update delivery status
 * PATCH /api/v1/deliveries/:id/status
 */
const updateDeliveryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        },
      });
    }

    const updateData = { status };

    if (status === 'picked_up') updateData.pickedUpAt = new Date();
    if (status === 'delivered') updateData.deliveredAt = new Date();
    if (status === 'failed') updateData.failedReason = req.body.failed_reason;

    const delivery = await prisma.delivery.update({
      where: { id },
      data: updateData,
      include: {
        order: true,
      },
    });

    logger.info(`Delivery ${id} status updated to ${status}`);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`location:${delivery.order.locationId}`).emit('delivery:status_updated', {
      delivery_id: id,
      order_number: delivery.order.orderNumber,
      status: status,
      estimated_arrival: delivery.estimatedDeliveryTime,
    });

    res.json({
      success: true,
      data: delivery,
    });
  } catch (error) {
    logger.error('Update delivery status error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update delivery status',
      },
    });
  }
};

/**
 * Complete delivery
 * PATCH /api/v1/deliveries/:id/complete
 */
const completeDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_signature, delivery_photo } = req.body;

    const delivery = await prisma.delivery.update({
      where: { id },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        customerSignature: customer_signature,
        deliveryPhoto: delivery_photo,
      },
    });

    // Calculate actual delivery time
    const deliveryTimeMinutes = Math.round(
      (delivery.deliveredAt - delivery.createdAt) / (1000 * 60)
    );

    logger.info(`Delivery completed: ${id}, Time: ${deliveryTimeMinutes} minutes`);

    res.json({
      success: true,
      data: {
        id: delivery.id,
        status: 'delivered',
        delivered_at: delivery.deliveredAt,
        delivery_time_minutes: deliveryTimeMinutes,
      },
    });
  } catch (error) {
    logger.error('Complete delivery error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to complete delivery',
      },
    });
  }
};

module.exports = {
  // Reservations
  createReservation,
  getReservations,
  getReservationById,
  updateReservationStatus,
  checkinReservation,
  cancelReservation,
  
  // Deliveries
  createDelivery,
  getDeliveries,
  getDeliveryById,
  assignDriver,
  updateDeliveryStatus,
  completeDelivery,
};