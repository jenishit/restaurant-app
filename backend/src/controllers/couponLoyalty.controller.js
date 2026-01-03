const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ============================================
// COUPON SYSTEM
// ============================================

/**
 * Get all coupons
 * GET /api/v1/coupons
 */
const getCoupons = async (req, res) => {
  try {
    const { is_active, location_id } = req.query;

    const where = {};
    if (is_active !== undefined) where.isActive = is_active === 'true';
    if (location_id) where.locationId = location_id;

    const coupons = await prisma.coupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        creator: {
          select: {
            name: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: coupons,
    });
  } catch (error) {
    logger.error('Get coupons error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch coupons',
      },
    });
  }
};

/**
 * Create coupon
 * POST /api/v1/coupons
 */
const createCoupon = async (req, res) => {
  try {
    const {
      code,
      description,
      discount_type,
      discount_value,
      min_order_amount,
      max_discount_amount,
      valid_from,
      valid_to,
      usage_limit,
      per_customer_limit,
      applicable_to,
      applicable_ids,
      location_id,
    } = req.body;

    if (!code || !discount_type || !discount_value || !valid_from || !valid_to) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
        },
      });
    }

    // Check if code already exists
    const existing = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'COUPON_EXISTS',
          message: 'Coupon code already exists',
        },
      });
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: code.toUpperCase(),
        description,
        discountType: discount_type,
        discountValue: discount_value,
        minOrderAmount: min_order_amount || 0,
        maxDiscountAmount: max_discount_amount,
        validFrom: new Date(valid_from),
        validTo: new Date(valid_to),
        usageLimit: usage_limit,
        perCustomerLimit: per_customer_limit || 1,
        applicableTo: applicable_to || 'all',
        applicableIds: applicable_ids || [],
        locationId: location_id,
        createdBy: req.user.id,
      },
    });

    logger.info(`Coupon created: ${coupon.code}`);

    res.status(201).json({
      success: true,
      data: coupon,
    });
  } catch (error) {
    logger.error('Create coupon error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create coupon',
      },
    });
  }
};

/**
 * Update coupon
 * PUT /api/v1/coupons/:id
 */
const updateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {};

    const allowedFields = [
      'description', 'discount_value', 'min_order_amount', 'max_discount_amount',
      'valid_from', 'valid_to', 'usage_limit', 'per_customer_limit', 'is_active'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        const prismaField = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        updateData[prismaField] = field.includes('valid_') ? new Date(req.body[field]) : req.body[field];
      }
    }

    const coupon = await prisma.coupon.update({
      where: { id },
      data: updateData,
    });

    logger.info(`Coupon updated: ${coupon.code}`);

    res.json({
      success: true,
      data: coupon,
    });
  } catch (error) {
    logger.error('Update coupon error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update coupon',
      },
    });
  }
};

/**
 * Validate coupon
 * POST /api/v1/coupons/validate
 */
const validateCoupon = async (req, res) => {
  try {
    const { code, order_amount, customer_id } = req.body;

    if (!code || !order_amount) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Code and order amount are required',
        },
      });
    }

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (!coupon || !coupon.isActive) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: {
          code: 'INVALID_COUPON',
          message: 'Coupon is invalid or inactive',
        },
      });
    }

    // Check validity dates
    const now = new Date();
    if (now < coupon.validFrom || now > coupon.validTo) {
      return res.status(400).json({
        success: false,
        valid: false,
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
        valid: false,
        error: {
          code: 'USAGE_LIMIT_REACHED',
          message: 'Coupon usage limit reached',
        },
      });
    }

    // Check minimum order amount
    if (order_amount < Number(coupon.minOrderAmount)) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: {
          code: 'MIN_ORDER_NOT_MET',
          message: `Minimum order amount of $${coupon.minOrderAmount} required`,
        },
      });
    }

    // Check per-customer usage if customer_id provided
    if (customer_id) {
      const customerUsage = await prisma.payment.count({
        where: {
          couponId: coupon.id,
          order: {
            customerId: customer_id,
          },
        },
      });

      if (customerUsage >= coupon.perCustomerLimit) {
        return res.status(400).json({
          success: false,
          valid: false,
          error: {
            code: 'CUSTOMER_LIMIT_REACHED',
            message: 'You have already used this coupon',
          },
        });
      }
    }

    // Calculate discount
    let discountAmount = 0;
    if (coupon.discountType === 'percentage') {
      discountAmount = (order_amount * Number(coupon.discountValue)) / 100;
      if (coupon.maxDiscountAmount) {
        discountAmount = Math.min(discountAmount, Number(coupon.maxDiscountAmount));
      }
    } else {
      discountAmount = Number(coupon.discountValue);
    }

    const finalAmount = Math.max(0, order_amount - discountAmount);

    res.json({
      success: true,
      data: {
        valid: true,
        code: coupon.code,
        discount_amount: discountAmount.toFixed(2),
        final_amount: finalAmount.toFixed(2),
        message: 'Coupon applied successfully',
      },
    });
  } catch (error) {
    logger.error('Validate coupon error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Coupon validation failed',
      },
    });
  }
};

/**
 * Delete coupon
 * DELETE /api/v1/coupons/:id
 */
const deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.coupon.delete({
      where: { id },
    });

    logger.info(`Coupon deleted: ${id}`);

    res.json({
      success: true,
      message: 'Coupon deleted successfully',
    });
  } catch (error) {
    logger.error('Delete coupon error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete coupon',
      },
    });
  }
};

// ============================================
// LOYALTY PROGRAM
// ============================================

/**
 * Get customer loyalty info
 * GET /api/v1/loyalty/customers/:phone
 */
const getCustomerLoyalty = async (req, res) => {
  try {
    const { phone } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { phone },
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Customer not found',
        },
      });
    }

    // Get available rewards
    const rewards = await prisma.loyaltyReward.findMany({
      where: {
        isActive: true,
        pointsRequired: { lte: customer.loyaltyPoints },
      },
      orderBy: { pointsRequired: 'asc' },
    });

    // Calculate points to next tier
    const tierThresholds = {
      bronze: 0,
      silver: 500,
      gold: 2000,
      platinum: 5000,
    };

    const currentTierSpent = Number(customer.totalSpent);
    let nextTier = null;
    let pointsToNextTier = 0;

    const tiers = ['bronze', 'silver', 'gold', 'platinum'];
    const currentIndex = tiers.indexOf(customer.loyaltyTier);
    if (currentIndex < tiers.length - 1) {
      nextTier = tiers[currentIndex + 1];
      pointsToNextTier = tierThresholds[nextTier] - currentTierSpent;
    }

    res.json({
      success: true,
      data: {
        customer: {
          id: customer.id,
          phone: customer.phone,
          name: customer.name,
          email: customer.email,
          loyalty_points: customer.loyaltyPoints,
          loyalty_tier: customer.loyaltyTier,
          total_orders: customer.totalOrders,
          total_spent: customer.totalSpent,
          member_since: customer.createdAt,
        },
        available_rewards: rewards.map(r => ({
          id: r.id,
          name: r.name,
          points_required: r.pointsRequired,
          can_redeem: customer.loyaltyPoints >= r.pointsRequired,
        })),
        points_to_next_tier: pointsToNextTier,
        next_tier: nextTier,
      },
    });
  } catch (error) {
    logger.error('Get customer loyalty error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch loyalty info',
      },
    });
  }
};

/**
 * Enroll customer in loyalty program
 * POST /api/v1/loyalty/customers
 */
const enrollCustomer = async (req, res) => {
  try {
    const { phone, name, email, date_of_birth } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Phone number is required',
        },
      });
    }

    // Check if already enrolled
    const existing = await prisma.customer.findUnique({
      where: { phone },
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_ENROLLED',
          message: 'Customer already enrolled',
        },
      });
    }

    const customer = await prisma.customer.create({
      data: {
        phone,
        name,
        email,
        dateOfBirth: date_of_birth ? new Date(date_of_birth) : null,
        loyaltyPoints: 50, // Welcome bonus
        loyaltyTier: 'bronze',
      },
    });

    // Create welcome bonus transaction
    await prisma.loyaltyTransaction.create({
      data: {
        customerId: customer.id,
        transactionType: 'earned',
        points: 50,
        balanceAfter: 50,
        description: 'Welcome bonus',
      },
    });

    logger.info(`Customer enrolled: ${customer.phone}`);

    res.status(201).json({
      success: true,
      data: {
        id: customer.id,
        phone: customer.phone,
        loyalty_points: customer.loyaltyPoints,
        loyalty_tier: customer.loyaltyTier,
        welcome_bonus: 50,
      },
    });
  } catch (error) {
    logger.error('Enroll customer error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to enroll customer',
      },
    });
  }
};

/**
 * Redeem loyalty reward
 * POST /api/v1/loyalty/redeem
 */
const redeemReward = async (req, res) => {
  try {
    const { customer_id, reward_id, order_id } = req.body;

    if (!customer_id || !reward_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Customer ID and reward ID are required',
        },
      });
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customer_id },
    });

    const reward = await prisma.loyaltyReward.findUnique({
      where: { id: reward_id },
    });

    if (!customer || !reward) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Customer or reward not found',
        },
      });
    }

    if (!reward.isActive) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'REWARD_INACTIVE',
          message: 'Reward is not active',
        },
      });
    }

    if (customer.loyaltyPoints < reward.pointsRequired) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_POINTS',
          message: 'Insufficient loyalty points',
        },
      });
    }

    // Check tier requirement
    if (reward.tierRequired) {
      const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
      const customerTierIndex = tierOrder.indexOf(customer.loyaltyTier);
      const requiredTierIndex = tierOrder.indexOf(reward.tierRequired);

      if (customerTierIndex < requiredTierIndex) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'TIER_REQUIRED',
            message: `${reward.tierRequired} tier required`,
          },
        });
      }
    }

    // Redeem in transaction
    await prisma.$transaction(async (tx) => {
      // Deduct points
      const newBalance = customer.loyaltyPoints - reward.pointsRequired;
      await tx.customer.update({
        where: { id: customer_id },
        data: { loyaltyPoints: newBalance },
      });

      // Create transaction
      await tx.loyaltyTransaction.create({
        data: {
          customerId: customer_id,
          orderId: order_id,
          transactionType: 'redeemed',
          points: -reward.pointsRequired,
          balanceAfter: newBalance,
          description: `Redeemed: ${reward.name}`,
        },
      });
    });

    logger.info(`Reward redeemed: ${reward.name} by customer ${customer.phone}`);

    res.json({
      success: true,
      data: {
        reward_name: reward.name,
        points_redeemed: reward.pointsRequired,
        remaining_points: customer.loyaltyPoints - reward.pointsRequired,
        discount_applied: reward.rewardValue,
      },
    });
  } catch (error) {
    logger.error('Redeem reward error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to redeem reward',
      },
    });
  }
};

/**
 * Get loyalty transaction history
 * GET /api/v1/loyalty/customers/:id/transactions
 */
const getLoyaltyTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date, page = 1, limit = 20 } = req.query;

    const where = { customerId: id };
    
    if (start_date || end_date) {
      where.createdAt = {};
      if (start_date) where.createdAt.gte = new Date(start_date);
      if (end_date) where.createdAt.lte = new Date(end_date);
    }

    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.loyaltyTransaction.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            select: {
              orderNumber: true,
            },
          },
        },
      }),
      prisma.loyaltyTransaction.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('Get loyalty transactions error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch transactions',
      },
    });
  }
};

module.exports = {
  // Coupons
  getCoupons,
  createCoupon,
  updateCoupon,
  validateCoupon,
  deleteCoupon,
  
  // Loyalty
  getCustomerLoyalty,
  enrollCustomer,
  redeemReward,
  getLoyaltyTransactions,
};