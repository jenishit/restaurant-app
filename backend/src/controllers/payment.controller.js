const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Calculate loyalty points earned
 */
const calculateLoyaltyPoints = (amount) => {
  // 1 point per dollar spent
  return Math.floor(amount);
};

/**
 * Process payment
 * POST /api/v1/payments
 */
const processPayment = async (req, res) => {
  try {
    const {
      order_id,
      payment_method,
      amount,
      tip_amount,
      coupon_code,
      customer_id,
      loyalty_points_used,
    } = req.body;

    if (!order_id || !payment_method || !amount) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Order ID, payment method, and amount are required',
        },
      });
    }

    // Get order
    const order = await prisma.order.findUnique({
      where: { id: order_id },
      include: {
        payments: true,
        customer: true,
      },
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

    if (order.status === 'completed') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ORDER_ALREADY_PAID',
          message: 'Order has already been paid',
        },
      });
    }

    let coupon = null;
    let discountAmount = 0;
    let loyaltyDiscount = 0;

    // Validate and apply coupon
    if (coupon_code) {
      coupon = await prisma.coupon.findUnique({
        where: { code: coupon_code },
      });

      if (!coupon || !coupon.isActive) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_COUPON',
            message: 'Coupon is invalid or expired',
          },
        });
      }

      // Check validity dates
      const now = new Date();
      if (now < coupon.validFrom || now > coupon.validTo) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'COUPON_EXPIRED',
            message: 'Coupon is not valid at this time',
          },
        });
      }

      // Check usage limit
      if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'COUPON_LIMIT_REACHED',
            message: 'Coupon usage limit reached',
          },
        });
      }

      // Check minimum order amount
      if (Number(order.subtotal) < Number(coupon.minOrderAmount)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MIN_ORDER_NOT_MET',
            message: `Minimum order amount of $${coupon.minOrderAmount} required`,
          },
        });
      }

      // Calculate discount
      if (coupon.discountType === 'percentage') {
        discountAmount = (Number(order.subtotal) * Number(coupon.discountValue)) / 100;
        if (coupon.maxDiscountAmount) {
          discountAmount = Math.min(discountAmount, Number(coupon.maxDiscountAmount));
        }
      } else {
        discountAmount = Number(coupon.discountValue);
      }
    }

    // Apply loyalty points
    if (loyalty_points_used && order.customer) {
      if (loyalty_points_used > order.customer.loyaltyPoints) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_POINTS',
            message: 'Insufficient loyalty points',
          },
        });
      }
      // 100 points = $1 discount
      loyaltyDiscount = loyalty_points_used / 100;
    }

    const totalDiscount = discountAmount + loyaltyDiscount;
    const finalAmount = Math.max(0, amount - totalDiscount);

    // Process payment in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create payment
      const payment = await tx.payment.create({
        data: {
          orderId: order_id,
          paymentMethod: payment_method,
          amount: finalAmount,
          tipAmount: tip_amount || 0,
          couponId: coupon?.id,
          discountAmount: discountAmount,
          loyaltyPointsUsed: loyalty_points_used || 0,
          loyaltyDiscount: loyaltyDiscount,
          status: 'completed',
          processedBy: req.user.id,
        },
      });

      // Update order status
      await tx.order.update({
        where: { id: order_id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          discountAmount: totalDiscount,
          total: finalAmount,
        },
      });

      // Update coupon usage
      if (coupon) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: {
            usageCount: { increment: 1 },
          },
        });
      }

      // Update customer loyalty
      if (customer_id || order.customerId) {
        const custId = customer_id || order.customerId;
        const customer = await tx.customer.findUnique({
          where: { id: custId },
        });

        // Deduct used points
        let newPoints = customer.loyaltyPoints - (loyalty_points_used || 0);
        
        // Add earned points
        const pointsEarned = calculateLoyaltyPoints(finalAmount);
        newPoints += pointsEarned;

        // Update customer
        await tx.customer.update({
          where: { id: custId },
          data: {
            loyaltyPoints: newPoints,
            totalOrders: { increment: 1 },
            totalSpent: { increment: finalAmount },
            lastOrderDate: new Date(),
          },
        });

        // Create loyalty transaction for points used
        if (loyalty_points_used > 0) {
          await tx.loyaltyTransaction.create({
            data: {
              customerId: custId,
              orderId: order_id,
              transactionType: 'redeemed',
              points: -loyalty_points_used,
              balanceAfter: customer.loyaltyPoints - loyalty_points_used,
              description: `Redeemed ${loyalty_points_used} points`,
            },
          });
        }

        // Create loyalty transaction for points earned
        if (pointsEarned > 0) {
          await tx.loyaltyTransaction.create({
            data: {
              customerId: custId,
              orderId: order_id,
              transactionType: 'earned',
              points: pointsEarned,
              balanceAfter: newPoints,
              description: `Earned from order ${order.orderNumber}`,
            },
          });
        }

        // Update loyalty tier
        const totalSpent = Number(customer.totalSpent) + finalAmount;
        let newTier = 'bronze';
        if (totalSpent >= 5000) newTier = 'platinum';
        else if (totalSpent >= 2000) newTier = 'gold';
        else if (totalSpent >= 500) newTier = 'silver';

        if (newTier !== customer.loyaltyTier) {
          await tx.customer.update({
            where: { id: custId },
            data: { loyaltyTier: newTier },
          });
        }
      }

      // Free up table if dine-in
      if (order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data: {
            status: 'available',
            currentOrderId: null,
          },
        });
      }

      return payment;
    });

    logger.info(`Payment processed: Order ${order.orderNumber}, Amount: $${finalAmount}`);

    // Emit socket event
    const io = req.app.get('io');
    io.to(`location:${order.locationId}`).emit('payment:completed', {
      payment_id: result.id,
      order_id: order.id,
      order_number: order.orderNumber,
      amount: finalAmount,
      table_number: order.table?.tableNumber,
    });

    res.status(201).json({
      success: true,
      data: {
        id: result.id,
        order_id: order.id,
        order_number: order.orderNumber,
        payment_method: result.paymentMethod,
        subtotal: order.subtotal,
        tax_amount: order.taxAmount,
        discount_amount: discountAmount,
        loyalty_discount: loyaltyDiscount,
        total: finalAmount,
        tip_amount: result.tipAmount,
        grand_total: Number(finalAmount) + Number(result.tipAmount),
        coupon_applied: coupon ? {
          code: coupon.code,
          discount: discountAmount,
        } : null,
        loyalty_points_earned: customer_id ? calculateLoyaltyPoints(finalAmount) : 0,
        loyalty_points_used: loyalty_points_used || 0,
        status: result.status,
        payment_date: result.paymentDate,
      },
    });
  } catch (error) {
    logger.error('Process payment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Payment processing failed',
      },
    });
  }
};

/**
 * Split payment
 * POST /api/v1/payments/split
 */
const splitPayment = async (req, res) => {
  try {
    const { order_id, splits } = req.body;

    if (!order_id || !splits || splits.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Order ID and splits array are required',
        },
      });
    }

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

    // Verify split amounts add up to order total
    const totalSplitAmount = splits.reduce((sum, split) => sum + split.amount, 0);
    if (Math.abs(totalSplitAmount - Number(order.total)) > 0.01) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_SPLIT',
          message: 'Split amounts must equal order total',
        },
      });
    }

    // Process all payments in transaction
    const payments = await prisma.$transaction(async (tx) => {
      const createdPayments = [];

      for (const split of splits) {
        const payment = await tx.payment.create({
          data: {
            orderId: order_id,
            paymentMethod: split.payment_method,
            amount: split.amount,
            tipAmount: split.tip_amount || 0,
            status: 'completed',
            processedBy: req.user.id,
          },
        });
        createdPayments.push(payment);
      }

      // Update order status
      await tx.order.update({
        where: { id: order_id },
        data: {
          status: 'completed',
          completedAt: new Date(),
        },
      });

      // Free up table if dine-in
      if (order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data: {
            status: 'available',
            currentOrderId: null,
          },
        });
      }

      return createdPayments;
    });

    logger.info(`Split payment processed: Order ${order.orderNumber}, ${payments.length} splits`);

    res.status(201).json({
      success: true,
      data: {
        order_id: order.id,
        total_paid: totalSplitAmount,
        total_tip: splits.reduce((sum, split) => sum + (split.tip_amount || 0), 0),
        payments: payments.map(p => ({
          id: p.id,
          amount: p.amount,
          payment_method: p.paymentMethod,
          tip_amount: p.tipAmount,
        })),
      },
    });
  } catch (error) {
    logger.error('Split payment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Split payment processing failed',
      },
    });
  }
};

/**
 * Get payment by order
 * GET /api/v1/payments/order/:order_id
 */
const getPaymentByOrder = async (req, res) => {
  try {
    const { order_id } = req.params;

    const payments = await prisma.payment.findMany({
      where: { orderId: order_id },
      include: {
        coupon: {
          select: {
            code: true,
            description: true,
          },
        },
        processedByUser: {
          select: {
            name: true,
          },
        },
      },
    });

    if (payments.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'No payments found for this order',
        },
      });
    }

    const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalTip = payments.reduce((sum, p) => sum + Number(p.tipAmount), 0);

    res.json({
      success: true,
      data: {
        order_id,
        payments,
        total_paid: totalPaid.toFixed(2),
        total_tip: totalTip.toFixed(2),
      },
    });
  } catch (error) {
    logger.error('Get payment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch payments',
      },
    });
  }
};

/**
 * Refund payment
 * POST /api/v1/payments/:id/refund
 */
const refundPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { order: true },
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Payment not found',
        },
      });
    }

    if (payment.status === 'refunded') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'ALREADY_REFUNDED',
          message: 'Payment has already been refunded',
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      // Update payment status
      await tx.payment.update({
        where: { id },
        data: {
          status: 'refunded',
          notes: reason,
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'payment_refunded',
          entityType: 'payment',
          entityId: id,
          newValues: { reason, amount: payment.amount },
        },
      });

      // Reverse loyalty points if applicable
      if (payment.order.customerId) {
        const pointsToReverse = calculateLoyaltyPoints(Number(payment.amount));
        
        await tx.customer.update({
          where: { id: payment.order.customerId },
          data: {
            loyaltyPoints: { decrement: pointsToReverse },
            totalSpent: { decrement: Number(payment.amount) },
          },
        });

        await tx.loyaltyTransaction.create({
          data: {
            customerId: payment.order.customerId,
            orderId: payment.orderId,
            transactionType: 'adjusted',
            points: -pointsToReverse,
            balanceAfter: 0, // Will be calculated
            description: `Refund for order ${payment.order.orderNumber}`,
          },
        });
      }
    });

    logger.info(`Payment refunded: ${id}, Amount: $${payment.amount}`);

    res.json({
      success: true,
      message: 'Payment refunded successfully',
      data: {
        payment_id: id,
        amount_refunded: payment.amount,
      },
    });
  } catch (error) {
    logger.error('Refund payment error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Refund processing failed',
      },
    });
  }
};

module.exports = {
  processPayment,
  splitPayment,
  getPaymentByOrder,
  refundPayment,
};