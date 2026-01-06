const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Get daily sales report
 * GET /api/v1/reports/sales/daily
 */
const getDailySalesReport = async (req, res) => {
  try {
    const { location_id, date } = req.query;

    const reportDate = date ? new Date(date) : new Date();
    const startDate = new Date(reportDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(reportDate);
    endDate.setHours(23, 59, 59, 999);

    const where = {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
    };

    if (location_id) where.locationId = location_id;
    if (req.user.role !== 'admin' && req.user.locationId) {
      where.locationId = req.user.locationId;
    }

    // Get all orders for the day
    const orders = await prisma.order.findMany({
      where,
      include: {
        items: {
          include: {
            menuItem: {
              select: {
                name: true,
                category: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
        payments: true,
      },
    });

    // Calculate summary
    const summary = {
      total_orders: orders.length,
      completed_orders: orders.filter(o => o.status === 'completed').length,
      cancelled_orders: orders.filter(o => o.status === 'cancelled').length,
      total_revenue: 0,
      total_tax: 0,
      total_discounts: 0,
      total_tips: 0,
      average_order_value: 0,
    };

    orders.forEach(order => {
      if (order.status === 'completed') {
        summary.total_revenue += Number(order.total);
        summary.total_tax += Number(order.taxAmount);
        summary.total_discounts += Number(order.discountAmount);
        
        order.payments.forEach(payment => {
          summary.total_tips += Number(payment.tipAmount);
        });
      }
    });

    summary.average_order_value = summary.completed_orders > 0 ? 
      summary.total_revenue / summary.completed_orders : 0;

    // Order types breakdown
    const orderTypes = {
      dine_in: { count: 0, revenue: 0 },
      takeout: { count: 0, revenue: 0 },
      delivery: { count: 0, revenue: 0 },
    };

    orders.forEach(order => {
      if (order.status === 'completed') {
        orderTypes[order.orderType].count++;
        orderTypes[order.orderType].revenue += Number(order.total);
      }
    });

    // Payment methods breakdown
    const paymentMethods = {};
    orders.forEach(order => {
      order.payments.forEach(payment => {
        if (!paymentMethods[payment.paymentMethod]) {
          paymentMethods[payment.paymentMethod] = {
            count: 0,
            amount: 0,
          };
        }
        paymentMethods[payment.paymentMethod].count++;
        paymentMethods[payment.paymentMethod].amount += Number(payment.amount);
      });
    });

    // Top selling items
    const itemSales = {};
    orders.forEach(order => {
      if (order.status === 'completed') {
        order.items.forEach(item => {
          const itemName = item.menuItem.name;
          if (!itemSales[itemName]) {
            itemSales[itemName] = {
              quantity: 0,
              revenue: 0,
            };
          }
          itemSales[itemName].quantity += item.quantity;
          itemSales[itemName].revenue += Number(item.subtotal);
        });
      }
    });

    const topSellingItems = Object.entries(itemSales)
      .map(([name, data]) => ({
        item_name: name,
        quantity_sold: data.quantity,
        revenue: data.revenue.toFixed(2),
      }))
      .sort((a, b) => b.quantity_sold - a.quantity_sold)
      .slice(0, 10);

    // Hourly breakdown
    const hourlyBreakdown = {};
    for (let hour = 0; hour < 24; hour++) {
      hourlyBreakdown[hour] = { orders: 0, revenue: 0 };
    }

    orders.forEach(order => {
      if (order.status === 'completed') {
        const hour = order.createdAt.getHours();
        hourlyBreakdown[hour].orders++;
        hourlyBreakdown[hour].revenue += Number(order.total);
      }
    });

    const hourlyData = Object.entries(hourlyBreakdown)
      .filter(([_, data]) => data.orders > 0)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        orders: data.orders,
        revenue: data.revenue.toFixed(2),
      }));

    res.json({
      success: true,
      data: {
        date: reportDate.toISOString().split('T')[0],
        location_id,
        summary: {
          ...summary,
          total_revenue: summary.total_revenue.toFixed(2),
          total_tax: summary.total_tax.toFixed(2),
          total_discounts: summary.total_discounts.toFixed(2),
          total_tips: summary.total_tips.toFixed(2),
          average_order_value: summary.average_order_value.toFixed(2),
        },
        order_types: orderTypes,
        payment_methods: paymentMethods,
        top_selling_items: topSellingItems,
        hourly_breakdown: hourlyData,
      },
    });
  } catch (error) {
    logger.error('Get daily sales report error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate daily sales report',
      },
    });
  }
};

/**
 * Get revenue report
 * GET /api/v1/reports/revenue
 */
const getRevenueReport = async (req, res) => {
  try {
    const { location_id, start_date, end_date, group_by = 'day' } = req.query;

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    endDate.setHours(23, 59, 59, 999);

    const where = {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      status: 'completed',
    };

    if (location_id) where.locationId = location_id;
    if (req.user.role !== 'admin' && req.user.locationId) {
      where.locationId = req.user.locationId;
    }

    const orders = await prisma.order.findMany({
      where,
      select: {
        total: true,
        createdAt: true,
      },
    });

    const totalRevenue = orders.reduce((sum, order) => sum + Number(order.total), 0);
    const totalOrders = orders.length;
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Group by time period
    const breakdown = {};
    orders.forEach(order => {
      let key;
      const date = new Date(order.createdAt);
      
      if (group_by === 'day') {
        key = date.toISOString().split('T')[0];
      } else if (group_by === 'week') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else if (group_by === 'month') {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!breakdown[key]) {
        breakdown[key] = {
          revenue: 0,
          orders: 0,
        };
      }

      breakdown[key].revenue += Number(order.total);
      breakdown[key].orders++;
    });

    const breakdownArray = Object.entries(breakdown)
      .map(([period, data]) => ({
        date: period,
        revenue: data.revenue.toFixed(2),
        orders: data.orders,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      data: {
        period: {
          start: start_date,
          end: end_date,
        },
        total_revenue: totalRevenue.toFixed(2),
        total_orders: totalOrders,
        average_order_value: averageOrderValue.toFixed(2),
        breakdown: breakdownArray,
      },
    });
  } catch (error) {
    logger.error('Get revenue report error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate revenue report',
      },
    });
  }
};

/**
 * Get item performance report
 * GET /api/v1/reports/items/performance
 */
const getItemPerformanceReport = async (req, res) => {
  try {
    const { location_id, start_date, end_date, limit = 20 } = req.query;

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    endDate.setHours(23, 59, 59, 999);

    const where = {
      order: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        status: 'completed',
      },
      status: { not: 'voided' },
    };

    if (location_id) {
      where.order.locationId = location_id;
    }

    const orderItems = await prisma.orderItem.findMany({
      where,
      include: {
        menuItem: {
          include: {
            category: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });

    // Aggregate by menu item
    const itemStats = {};
    orderItems.forEach(item => {
      const itemId = item.menuItemId;
      if (!itemStats[itemId]) {
        itemStats[itemId] = {
          menu_item_id: itemId,
          item_name: item.menuItem.name,
          category_name: item.menuItem.category.name,
          quantity_sold: 0,
          revenue: 0,
          cost: 0,
          times_voided: 0,
        };
      }

      itemStats[itemId].quantity_sold += item.quantity;
      itemStats[itemId].revenue += Number(item.subtotal);
      itemStats[itemId].cost += Number(item.menuItem.cost || 0) * item.quantity;
    });

    // Get void counts
    const voidedItems = await prisma.orderItem.findMany({
      where: {
        ...where,
        status: 'voided',
      },
      select: {
        menuItemId: true,
      },
    });

    voidedItems.forEach(item => {
      if (itemStats[item.menuItemId]) {
        itemStats[item.menuItemId].times_voided++;
      }
    });

    // Calculate profit and margins
    const itemPerformance = Object.values(itemStats)
      .map(item => ({
        ...item,
        profit: (item.revenue - item.cost).toFixed(2),
        profit_margin: item.revenue > 0 ? 
          (((item.revenue - item.cost) / item.revenue) * 100).toFixed(1) : 0,
        revenue: item.revenue.toFixed(2),
        cost: item.cost.toFixed(2),
      }))
      .sort((a, b) => b.quantity_sold - a.quantity_sold)
      .slice(0, parseInt(limit));

    res.json({
      success: true,
      data: itemPerformance,
    });
  } catch (error) {
    logger.error('Get item performance error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate item performance report',
      },
    });
  }
};

/**
 * Get waiter performance report
 * GET /api/v1/reports/waiters/performance
 */
const getWaiterPerformanceReport = async (req, res) => {
  try {
    const { location_id, start_date, end_date } = req.query;

    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    endDate.setHours(23, 59, 59, 999);

    const where = {
      createdAt: {
        gte: startDate,
        lte: endDate,
      },
      status: 'completed',
    };

    if (location_id) where.locationId = location_id;

    const orders = await prisma.order.findMany({
      where,
      include: {
        waiter: {
          select: {
            id: true,
            name: true,
          },
        },
        payments: {
          select: {
            tipAmount: true,
          },
        },
      },
    });

    // Aggregate by waiter
    const waiterStats = {};
    orders.forEach(order => {
      if (!order.waiterId) return;

      const waiterId = order.waiterId;
      if (!waiterStats[waiterId]) {
        waiterStats[waiterId] = {
          waiter_id: waiterId,
          waiter_name: order.waiter.name,
          total_orders: 0,
          total_revenue: 0,
          total_tips: 0,
          cancelled_orders: 0,
        };
      }

      waiterStats[waiterId].total_orders++;
      waiterStats[waiterId].total_revenue += Number(order.total);
      
      order.payments.forEach(payment => {
        waiterStats[waiterId].total_tips += Number(payment.tipAmount);
      });
    });

    // Get cancelled orders
    const cancelledOrders = await prisma.order.findMany({
      where: {
        ...where,
        status: 'cancelled',
      },
      select: {
        waiterId: true,
      },
    });

    cancelledOrders.forEach(order => {
      if (order.waiterId && waiterStats[order.waiterId]) {
        waiterStats[order.waiterId].cancelled_orders++;
      }
    });

    // Calculate averages
    const waiterPerformance = Object.values(waiterStats)
      .map(waiter => ({
        ...waiter,
        average_order_value: (waiter.total_revenue / waiter.total_orders).toFixed(2),
        average_tip_percentage: waiter.total_revenue > 0 ? 
          ((waiter.total_tips / waiter.total_revenue) * 100).toFixed(1) : 0,
        total_revenue: waiter.total_revenue.toFixed(2),
        total_tips: waiter.total_tips.toFixed(2),
      }))
      .sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({
      success: true,
      data: waiterPerformance,
    });
  } catch (error) {
    logger.error('Get waiter performance error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate waiter performance report',
      },
    });
  }
};

/**
 * Get inventory alert report
 * GET /api/v1/reports/inventory/alerts
 */
const getInventoryAlertReport = async (req, res) => {
  try {
    const { location_id } = req.query;

    const where = {};
    if (location_id) where.locationId = location_id;

    // Get out of stock items
    const outOfStock = await prisma.menuItem.findMany({
      where: {
        ...where,
        isAvailable: false,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        category: {
          select: {
            name: true,
          },
        },
        updatedAt: true,
      },
    });

    // Get low-performing items (ordered less than usual today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todaysOrders = await prisma.orderItem.findMany({
      where: {
        order: {
          createdAt: {
            gte: today,
            lt: tomorrow,
          },
          status: 'completed',
        },
      },
      include: {
        menuItem: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Calculate averages (simplified - in production use better historical data)
    const itemOrderCounts = {};
    todaysOrders.forEach(item => {
      const itemId = item.menuItemId;
      if (!itemOrderCounts[itemId]) {
        itemOrderCounts[itemId] = {
          menu_item_id: itemId,
          item_name: item.menuItem.name,
          orders_today: 0,
        };
      }
      itemOrderCounts[itemId].orders_today += item.quantity;
    });

    res.json({
      success: true,
      data: {
        out_of_stock: outOfStock.map(item => ({
          menu_item_id: item.id,
          item_name: item.name,
          category: item.category.name,
          last_available: item.updatedAt,
        })),
        low_orders_today: Object.values(itemOrderCounts)
          .filter(item => item.orders_today < 5)
          .slice(0, 10),
      },
    });
  } catch (error) {
    logger.error('Get inventory alert error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate inventory alert report',
      },
    });
  }
};

/**
 * Get customer analytics
 * GET /api/v1/reports/customers/analytics
 */
const getCustomerAnalytics = async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const dateFilter = {};
    if (start_date && end_date) {
      dateFilter.createdAt = {
        gte: new Date(start_date),
        lte: new Date(end_date),
      };
    }

    // Total customers
    const totalCustomers = await prisma.customer.count();

    // New customers in period
    const newCustomers = await prisma.customer.count({
      where: dateFilter,
    });

    // Loyalty tier distribution
    const tierDistribution = await prisma.customer.groupBy({
      by: ['loyaltyTier'],
      _count: true,
    });

    const tierStats = {};
    tierDistribution.forEach(tier => {
      tierStats[tier.loyaltyTier] = tier._count;
    });

    // Top customers
    const topCustomers = await prisma.customer.findMany({
      orderBy: {
        totalSpent: 'desc',
      },
      take: 10,
      select: {
        id: true,
        name: true,
        phone: true,
        totalOrders: true,
        totalSpent: true,
        loyaltyTier: true,
        loyaltyPoints: true,
      },
    });

    // Calculate returning customers (simplified)
    const returningCustomers = await prisma.customer.count({
      where: {
        totalOrders: {
          gt: 1,
        },
      },
    });

    res.json({
      success: true,
      data: {
        total_customers: totalCustomers,
        new_customers: newCustomers,
        returning_customers: returningCustomers,
        loyalty_members: totalCustomers,
        tier_distribution: tierStats,
        top_customers: topCustomers,
      },
    });
  } catch (error) {
    logger.error('Get customer analytics error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate customer analytics',
      },
    });
  }
};

/**
 * Get dashboard summary
 * GET /api/v1/reports/dashboard
 */
const getDashboardSummary = async (req, res) => {
  try {
    const { location_id } = req.query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const where = {
      createdAt: {
        gte: today,
        lt: tomorrow,
      },
    };

    if (location_id) where.locationId = location_id;
    if (req.user.role !== 'admin' && req.user.locationId) {
      where.locationId = req.user.locationId;
    }

    // Today's orders
    const [totalOrders, completedOrders, activeOrders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.count({ where: { ...where, status: 'completed' } }),
      prisma.order.count({
        where: {
          ...where,
          status: {
            in: ['pending', 'confirmed', 'preparing', 'ready', 'served'],
          },
        },
      }),
    ]);

    // Today's revenue
    const completedOrdersData = await prisma.order.findMany({
      where: { ...where, status: 'completed' },
      select: { total: true },
    });

    const todaysRevenue = completedOrdersData.reduce(
      (sum, order) => sum + Number(order.total),
      0
    );

    // Table status
    const tableWhere = {};
    if (location_id) tableWhere.locationId = location_id;
    if (req.user.role !== 'admin' && req.user.locationId) {
      tableWhere.locationId = req.user.locationId;
    }

    const tables = await prisma.table.groupBy({
      by: ['status'],
      where: tableWhere,
      _count: true,
    });

    const tableStats = {
      total: 0,
      available: 0,
      occupied: 0,
      reserved: 0,
    };

    tables.forEach(t => {
      tableStats.total += t._count;
      tableStats[t.status] = t._count;
    });

    // Recent activity
    const recentOrders = await prisma.order.findMany({
      where: {
        ...where,
        status: {
          notIn: ['completed', 'cancelled'],
        },
      },
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        total: true,
        table: {
          select: {
            tableNumber: true,
          },
        },
      },
    });

    res.json({
      success: true,
      data: {
        today: {
          total_orders: totalOrders,
          completed_orders: completedOrders,
          active_orders: activeOrders,
          revenue: todaysRevenue.toFixed(2),
        },
        tables: tableStats,
        recent_activity: recentOrders,
      },
    });
  } catch (error) {
    logger.error('Get dashboard summary error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to generate dashboard summary',
      },
    });
  }
};

module.exports = {
  getDailySalesReport,
  getRevenueReport,
  getItemPerformanceReport,
  getWaiterPerformanceReport,
  getInventoryAlertReport,
  getCustomerAnalytics,
  getDashboardSummary,
};