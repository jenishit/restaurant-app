const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Generate unique order number
 */
const generateOrderNumber = async (locationId) => {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const prefix = `ORD-${today}`;
  
  // Count orders today
  const count = await prisma.order.count({
    where: {
      orderNumber: {
        startsWith: prefix,
      },
    },
  });

  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
};

/**
 * Calculate order totals
 */
const calculateTotals = async (items, locationId) => {
  let subtotal = 0;

  for (const item of items) {
    const menuItem = await prisma.menuItem.findUnique({
      where: { id: item.menu_item_id },
      include: { modifiers: true },
    });

    let itemPrice = Number(menuItem.price) * item.quantity;

    // Add modifier prices
    if (item.modifiers && item.modifiers.length > 0) {
      for (const mod of item.modifiers) {
        const modifier = menuItem.modifiers.find(m => m.id === mod.modifier_id);
        if (modifier) {
          itemPrice += Number(modifier.priceAdjustment) * item.quantity;
        }
      }
    }

    subtotal += itemPrice;
  }

  // Get tax rate from settings
  const taxSetting = await prisma.setting.findFirst({
    where: {
      locationId,
      key: 'tax_rate',
    },
  });

  const taxRate = taxSetting ? Number(taxSetting.value) : 0.08;
  const taxAmount = subtotal * taxRate;
  const total = subtotal + taxAmount;

  return {
    subtotal: subtotal.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    total: total.toFixed(2),
  };
};

/**
 * Create new order
 * POST /api/v1/orders
 */
const createOrder = async (req, res) => {
  try {
    const {
      locationId,
      tableId,
      customerId,
      orderType,
      customerName,
      customerPhone,
      specialInstructions,
      items,
    } = req.body;

    // Validation
    if (!locationId || !orderType || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
        },
      });
    }

    // Generate order number
    const orderNumber = await generateOrderNumber(locationId);

    // Calculate totals
    const { subtotal, taxAmount, total } = await calculateTotals(items, locationId);

    // Create order with items in transaction
    const order = await prisma.$transaction(async (tx) => {
      // Create order
      const newOrder = await tx.order.create({
        data: {
          orderNumber,
          locationId,
          tableId,
          customerId,
          orderType,
          status: 'pending',
          waiterId: req.user.id,
          subtotal,
          taxAmount,
          total,
          customerName,
          customerPhone,
          specialInstructions,
        },
      });

      // Create order items
      for (const item of items) {
        const menuItem = await tx.menuItem.findUnique({
          where: { id: item.menu_item_id },
          include: { modifiers: true },
        });

        let itemPrice = Number(menuItem.price);
        let modifierTotal = 0;

        // Calculate item total with modifiers
        if (item.modifiers && item.modifiers.length > 0) {
          for (const mod of item.modifiers) {
            const modifier = menuItem.modifiers.find(m => m.id === mod.modifier_id);
            if (modifier) {
              modifierTotal += Number(modifier.priceAdjustment);
            }
          }
        }

        const itemSubtotal = (itemPrice + modifierTotal) * item.quantity;

        // Create order item
        const orderItem = await tx.orderItem.create({
          data: {
            orderId: newOrder.id,
            menuItemId: item.menu_item_id,
            quantity: item.quantity,
            unitPrice: itemPrice,
            subtotal: itemSubtotal.toFixed(2),
            specialInstructions: item.special_instructions,
            status: 'pending',
          },
        });

        // Create modifier associations
        if (item.modifiers && item.modifiers.length > 0) {
          for (const mod of item.modifiers) {
            const modifier = menuItem.modifiers.find(m => m.id === mod.modifier_id);
            if (modifier) {
              await tx.orderItemModifier.create({
                data: {
                  orderItemId: orderItem.id,
                  modifierId: modifier.id,
                  modifierName: modifier.name,
                  priceAdjustment: modifier.priceAdjustment,
                },
              });
            }
          }
        }
      }

      // Update table status if dine-in
      if (tableId) {
        await tx.table.update({
          where: { id: tableId },
          data: {
            status: 'occupied',
            currentOrderId: newOrder.id,
          },
        });
      }

      // Fetch complete order with relations
      return tx.order.findUnique({
        where: { id: newOrder.id },
        include: {
          items: {
            include: {
              menuItem: true,
              modifiers: true,
            },
          },
          table: true,
          waiter: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
    });

    // Emit socket event for new order
    const io = req.app.get('io');
    io.to(`location:${locationId}`).emit('order:created', {
      order_id: order.id,
      order_number: order.orderNumber,
      table_number: order.table?.tableNumber,
      order_type: order.orderType,
      items: order.items,
      created_at: order.createdAt,
    });

    logger.info(`Order created: ${order.orderNumber} by ${req.user.name}`);

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    logger.error('Create order error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create order',
      },
    });
  }
};

/**
 * Get all orders with filters
 * GET /api/v1/orders
 */
const getOrders = async (req, res) => {
  try {
    const {
      locationId,
      status,
      orderType,
      tableId,
      date,
      page = 1,
      limit = 20,
    } = req.query;

    const skip = (page - 1) * limit;

    const where = {};

    if (locationId) where.locationId = locationId;
    if (status) where.status = status;
    if (orderType) where.orderType = orderType;
    if (tableId) where.tableId = tableId;

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

    // Non-admin users can only see their location
    if (req.user.role !== 'admin' && req.user.locationId) {
      where.locationId = req.user.locationId;
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          table: {
            select: {
              tableNumber: true,
            },
          },
          waiter: {
            select: {
              name: true,
            },
          },
          items: {
            select: {
              id: true,
              quantity: true,
            },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        orders: orders.map(order => ({
          ...order,
          table_number: order.table?.tableNumber,
          waiter_name: order.waiter?.name,
          item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    logger.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch orders',
      },
    });
  }
};

/**
 * Get order by ID
 * GET /api/v1/orders/:id
 */
const getOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        location: {
          select: {
            id: true,
            name: true,
          },
        },
        table: {
          select: {
            id: true,
            tableNumber: true,
          },
        },
        waiter: {
          select: {
            id: true,
            name: true,
          },
        },
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            loyaltyPoints: true,
            loyaltyTier: true,
          },
        },
        items: {
          include: {
            menuItem: {
              select: {
                id: true,
                name: true,
                imageUrl: true,
              },
            },
            modifiers: true,
          },
        },
        payments: true,
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

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    logger.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch order',
      },
    });
  }
};

/**
 * Update order status
 * PATCH /api/v1/orders/:id/status
 */
const updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, estimated_ready_time } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'completed', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Status must be one of: ${validStatuses.join(', ')}`,
        },
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: { location: true },
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

    // Build update data
    const updateData = { status };

    if (status === 'confirmed') updateData.confirmedAt = new Date();
    if (status === 'preparing') updateData.preparingAt = new Date();
    if (status === 'ready') updateData.readyAt = new Date();
    if (status === 'served') updateData.servedAt = new Date();
    if (status === 'completed') updateData.completedAt = new Date();
    if (status === 'cancelled') updateData.cancelledAt = new Date();

    if (estimated_ready_time) updateData.estimatedReadyTime = new Date(estimated_ready_time);

    // Update order
    const updatedOrder = await prisma.order.update({
      where: { id },
      data: updateData,
    });

    // Emit socket event
    const io = req.app.get('io');
    io.to(`location:${order.locationId}`).emit('order:status_updated', {
      order_id: order.id,
      order_number: order.orderNumber,
      old_status: order.status,
      new_status: status,
      updated_at: new Date(),
    });

    logger.info(`Order ${order.orderNumber} status updated to ${status}`);

    res.json({
      success: true,
      data: updatedOrder,
    });
  } catch (error) {
    logger.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update order status',
      },
    });
  }
};

/**
 * Add items to existing order
 * POST /api/v1/orders/:id/items
 */
const addItemsToOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Items array is required',
        },
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
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

    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: 'Cannot add items to completed or cancelled orders',
        },
      });
    }

    // Add items in transaction
    const result = await prisma.$transaction(async (tx) => {
      const addedItems = [];
      let additionalSubtotal = 0;

      for (const item of items) {
        const menuItem = await tx.menuItem.findUnique({
          where: { id: item.menu_item_id },
          include: { modifiers: true },
        });

        let itemPrice = Number(menuItem.price);
        let modifierTotal = 0;

        if (item.modifiers) {
          for (const mod of item.modifiers) {
            const modifier = menuItem.modifiers.find(m => m.id === mod.modifier_id);
            if (modifier) {
              modifierTotal += Number(modifier.priceAdjustment);
            }
          }
        }

        const itemSubtotal = (itemPrice + modifierTotal) * item.quantity;
        additionalSubtotal += itemSubtotal;

        const orderItem = await tx.orderItem.create({
          data: {
            orderId: id,
            menuItemId: item.menu_item_id,
            quantity: item.quantity,
            unitPrice: itemPrice,
            subtotal: itemSubtotal.toFixed(2),
            specialInstructions: item.special_instructions,
            status: 'pending',
          },
        });

        addedItems.push({
          id: orderItem.id,
          menu_item_name: menuItem.name,
          quantity: item.quantity,
          unit_price: itemPrice,
        });

        // Add modifiers
        if (item.modifiers) {
          for (const mod of item.modifiers) {
            const modifier = menuItem.modifiers.find(m => m.id === mod.modifier_id);
            if (modifier) {
              await tx.orderItemModifier.create({
                data: {
                  orderItemId: orderItem.id,
                  modifierId: modifier.id,
                  modifierName: modifier.name,
                  priceAdjustment: modifier.priceAdjustment,
                },
              });
            }
          }
        }
      }

      // Update order totals
      const newSubtotal = Number(order.subtotal) + additionalSubtotal;
      const taxRate = Number(order.taxAmount) / Number(order.subtotal);
      const newTaxAmount = newSubtotal * taxRate;
      const newTotal = newSubtotal + newTaxAmount;

      await tx.order.update({
        where: { id },
        data: {
          subtotal: newSubtotal.toFixed(2),
          taxAmount: newTaxAmount.toFixed(2),
          total: newTotal.toFixed(2),
        },
      });

      return {
        addedItems,
        newSubtotal: newSubtotal.toFixed(2),
        newTotal: newTotal.toFixed(2),
      };
    });

    logger.info(`Items added to order ${order.orderNumber}`);

    res.json({
      success: true,
      data: {
        order_id: id,
        added_items: result.addedItems,
        new_subtotal: result.newSubtotal,
        new_total: result.newTotal,
      },
    });
  } catch (error) {
    logger.error('Add items error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to add items',
      },
    });
  }
};

/**
 * Void/remove order item
 * DELETE /api/v1/orders/:id/items/:item_id
 */
const voidOrderItem = async (req, res) => {
  try {
    const { id, item_id } = req.params;
    const { reason } = req.body;

    // Check permissions
    const order = await prisma.order.findUnique({
      where: { id },
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

    // After confirmation, only admin can void
    if (order.status !== 'pending' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only admins can void items from confirmed orders',
        },
      });
    }

    const orderItem = await prisma.orderItem.findUnique({
      where: { id: item_id },
      include: { menuItem: true },
    });

    if (!orderItem) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Order item not found',
        },
      });
    }

    // Void item in transaction
    await prisma.$transaction(async (tx) => {
      // Update item status
      await tx.orderItem.update({
        where: { id: item_id },
        data: {
          status: 'voided',
          voidedAt: new Date(),
          voidedBy: req.user.id,
          voidReason: reason,
        },
      });

      // Create void log
      await tx.voidLog.create({
        data: {
          orderId: id,
          orderItemId: item_id,
          voidedBy: req.user.id,
          voidReason: reason || 'No reason provided',
          itemName: orderItem.menuItem.name,
          quantity: orderItem.quantity,
          amountVoided: orderItem.subtotal,
        },
      });

      // Recalculate order totals
      const activeItems = await tx.orderItem.findMany({
        where: {
          orderId: id,
          status: { not: 'voided' },
        },
      });

      const newSubtotal = activeItems.reduce((sum, item) => sum + Number(item.subtotal), 0);
      const taxRate = Number(order.taxAmount) / Number(order.subtotal);
      const newTaxAmount = newSubtotal * taxRate;
      const newTotal = newSubtotal + newTaxAmount;

      await tx.order.update({
        where: { id },
        data: {
          subtotal: newSubtotal.toFixed(2),
          taxAmount: newTaxAmount.toFixed(2),
          total: newTotal.toFixed(2),
        },
      });
    });

    logger.info(`Item voided from order ${order.orderNumber} by ${req.user.name}`);

    res.json({
      success: true,
      message: 'Item voided successfully',
    });
  } catch (error) {
    logger.error('Void item error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to void item',
      },
    });
  }
};

/**
 * Transfer order to different table
 * PATCH /api/v1/orders/:id/transfer
 */
const transferOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { new_table_id } = req.body;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { table: true },
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

    const newTable = await prisma.table.findUnique({
      where: { id: new_table_id },
    });

    if (!newTable) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'New table not found',
        },
      });
    }

    // Transfer in transaction
    await prisma.$transaction(async (tx) => {
      // Free old table
      if (order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data: {
            status: 'available',
            currentOrderId: null,
          },
        });
      }

      // Occupy new table
      await tx.table.update({
        where: { id: new_table_id },
        data: {
          status: 'occupied',
          currentOrderId: id,
        },
      });

      // Update order
      await tx.order.update({
        where: { id },
        data: { tableId: new_table_id },
      });
    });

    logger.info(`Order ${order.orderNumber} transferred from ${order.table?.tableNumber} to ${newTable.tableNumber}`);

    res.json({
      success: true,
      data: {
        order_id: id,
        old_table_number: order.table?.tableNumber,
        new_table_number: newTable.tableNumber,
      },
    });
  } catch (error) {
    logger.error('Transfer order error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to transfer order',
      },
    });
  }
};

/**
 * Cancel order
 * DELETE /api/v1/orders/:id
 */
const cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Only admin can cancel
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only admins can cancel orders',
        },
      });
    }

    const order = await prisma.order.findUnique({
      where: { id },
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

    // Cancel in transaction
    await prisma.$transaction(async (tx) => {
      // Update order
      await tx.order.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
        },
      });

      // Free table
      if (order.tableId) {
        await tx.table.update({
          where: { id: order.tableId },
          data: {
            status: 'available',
            currentOrderId: null,
          },
        });
      }

      // Create audit log
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'order_cancelled',
          entityType: 'order',
          entityId: id,
          newValues: { reason: reason || 'No reason provided' },
        },
      });
    });

    logger.info(`Order ${order.orderNumber} cancelled by ${req.user.name}`);

    res.json({
      success: true,
      message: 'Order cancelled successfully',
    });
  } catch (error) {
    logger.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to cancel order',
      },
    });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  updateOrderStatus,
  addItemsToOrder,
  voidOrderItem,
  transferOrder,
  cancelOrder,
};