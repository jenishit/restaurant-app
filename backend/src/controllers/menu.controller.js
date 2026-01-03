const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/**
 * Get all categories
 * GET /api/v1/categories
 */
const getCategories = async (req, res) => {
  try {
    const { location_id, is_active } = req.query;

    const where = {};
    if (location_id) where.locationId = location_id;
    if (is_active !== undefined) where.isActive = is_active === 'true';

    const categories = await prisma.category.findMany({
      where,
      orderBy: { displayOrder: 'asc' },
      include: {
        _count: {
          select: { menuItems: true },
        },
      },
    });

    res.json({
      success: true,
      data: categories.map(cat => ({
        ...cat,
        item_count: cat._count.menuItems,
      })),
    });
  } catch (error) {
    logger.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch categories',
      },
    });
  }
};

/**
 * Create category
 * POST /api/v1/categories
 */
const createCategory = async (req, res) => {
  try {
    const { name, description, display_order, location_id, image_url } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Category name is required',
        },
      });
    }

    const category = await prisma.category.create({
      data: {
        name,
        description,
        displayOrder: display_order || 0,
        locationId: location_id,
        imageUrl: image_url,
      },
    });

    logger.info(`Category created: ${category.name}`);

    res.status(201).json({
      success: true,
      data: category,
    });
  } catch (error) {
    logger.error('Create category error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create category',
      },
    });
  }
};

/**
 * Update category
 * PUT /api/v1/categories/:id
 */
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, display_order, image_url, is_active } = req.body;

    const category = await prisma.category.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(display_order !== undefined && { displayOrder: display_order }),
        ...(image_url !== undefined && { imageUrl: image_url }),
        ...(is_active !== undefined && { isActive: is_active }),
      },
    });

    logger.info(`Category updated: ${category.name}`);

    res.json({
      success: true,
      data: category,
    });
  } catch (error) {
    logger.error('Update category error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update category',
      },
    });
  }
};

/**
 * Delete category
 * DELETE /api/v1/categories/:id
 */
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if category has items
    const itemCount = await prisma.menuItem.count({
      where: { categoryId: id },
    });

    if (itemCount > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CATEGORY_HAS_ITEMS',
          message: 'Cannot delete category with menu items',
        },
      });
    }

    await prisma.category.delete({
      where: { id },
    });

    logger.info(`Category deleted: ${id}`);

    res.json({
      success: true,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    logger.error('Delete category error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete category',
      },
    });
  }
};

/**
 * Get all menu items
 * GET /api/v1/menu-items
 */
const getMenuItems = async (req, res) => {
  try {
    const { category_id, location_id, is_available, search } = req.query;

    const where = {};
    if (category_id) where.categoryId = category_id;
    if (location_id) where.locationId = location_id;
    if (is_available !== undefined) where.isAvailable = is_available === 'true';
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const menuItems = await prisma.menuItem.findMany({
      where,
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
        modifiers: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    res.json({
      success: true,
      data: menuItems.map(item => ({
        ...item,
        category_name: item.category.name,
      })),
    });
  } catch (error) {
    logger.error('Get menu items error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch menu items',
      },
    });
  }
};

/**
 * Get menu item by ID
 * GET /api/v1/menu-items/:id
 */
const getMenuItemById = async (req, res) => {
  try {
    const { id } = req.params;

    const menuItem = await prisma.menuItem.findUnique({
      where: { id },
      include: {
        category: true,
        location: true,
        modifiers: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!menuItem) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Menu item not found',
        },
      });
    }

    res.json({
      success: true,
      data: menuItem,
    });
  } catch (error) {
    logger.error('Get menu item error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch menu item',
      },
    });
  }
};

/**
 * Create menu item
 * POST /api/v1/menu-items
 */
const createMenuItem = async (req, res) => {
  try {
    const {
      category_id,
      location_id,
      name,
      description,
      price,
      cost,
      image_url,
      prep_time_minutes,
      kitchen_station,
      allergens,
      tags,
    } = req.body;

    if (!category_id || !name || !price) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Category, name, and price are required',
        },
      });
    }

    const menuItem = await prisma.menuItem.create({
      data: {
        categoryId: category_id,
        locationId: location_id,
        name,
        description,
        price,
        cost,
        imageUrl: image_url,
        prepTimeMinutes: prep_time_minutes,
        kitchenStation: kitchen_station,
        allergens: allergens || [],
        tags: tags || [],
      },
    });

    logger.info(`Menu item created: ${menuItem.name}`);

    // Emit socket event
    const io = req.app.get('io');
    if (location_id) {
      io.to(`location:${location_id}`).emit('menu:item_added', {
        menu_item_id: menuItem.id,
        name: menuItem.name,
      });
    }

    res.status(201).json({
      success: true,
      data: menuItem,
    });
  } catch (error) {
    logger.error('Create menu item error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create menu item',
      },
    });
  }
};

/**
 * Update menu item
 * PUT /api/v1/menu-items/:id
 */
const updateMenuItem = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {};

    const allowedFields = [
      'name', 'description', 'price', 'cost', 'image_url', 'is_available',
      'is_active', 'prep_time_minutes', 'kitchen_station', 'allergens', 'tags'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        const prismaField = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        updateData[prismaField] = req.body[field];
      }
    }

    const menuItem = await prisma.menuItem.update({
      where: { id },
      data: updateData,
    });

    logger.info(`Menu item updated: ${menuItem.name}`);

    res.json({
      success: true,
      data: menuItem,
    });
  } catch (error) {
    logger.error('Update menu item error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update menu item',
      },
    });
  }
};

/**
 * Toggle item availability
 * PATCH /api/v1/menu-items/:id/availability
 */
const toggleAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_available } = req.body;

    const menuItem = await prisma.menuItem.update({
      where: { id },
      data: { isAvailable: is_available },
      include: { location: true },
    });

    logger.info(`Menu item ${menuItem.name} availability set to ${is_available}`);

    // Emit socket event
    const io = req.app.get('io');
    if (menuItem.locationId) {
      io.to(`location:${menuItem.locationId}`).emit('menu:availability_changed', {
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        is_available: is_available,
        updated_by: req.user.name,
      });
    }

    res.json({
      success: true,
      data: {
        id: menuItem.id,
        name: menuItem.name,
        is_available: menuItem.isAvailable,
      },
    });
  } catch (error) {
    logger.error('Toggle availability error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to toggle availability',
      },
    });
  }
};

/**
 * Delete menu item
 * DELETE /api/v1/menu-items/:id
 */
const deleteMenuItem = async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.menuItem.delete({
      where: { id },
    });

    logger.info(`Menu item deleted: ${id}`);

    res.json({
      success: true,
      message: 'Menu item deleted successfully',
    });
  } catch (error) {
    logger.error('Delete menu item error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete menu item',
      },
    });
  }
};

/**
 * Add modifier to menu item
 * POST /api/v1/menu-items/:id/modifiers
 */
const addModifier = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, price_adjustment, is_required, display_order } = req.body;

    if (!name || !type) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name and type are required',
        },
      });
    }

    const modifier = await prisma.modifier.create({
      data: {
        menuItemId: id,
        name,
        type,
        priceAdjustment: price_adjustment || 0,
        isRequired: is_required || false,
        displayOrder: display_order || 0,
      },
    });

    logger.info(`Modifier added to menu item ${id}: ${modifier.name}`);

    res.status(201).json({
      success: true,
      data: modifier,
    });
  } catch (error) {
    logger.error('Add modifier error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to add modifier',
      },
    });
  }
};

/**
 * Update modifier
 * PUT /api/v1/menu-items/:id/modifiers/:modifier_id
 */
const updateModifier = async (req, res) => {
  try {
    const { modifier_id } = req.params;
    const { name, price_adjustment, is_required, is_active, display_order } = req.body;

    const modifier = await prisma.modifier.update({
      where: { id: modifier_id },
      data: {
        ...(name && { name }),
        ...(price_adjustment !== undefined && { priceAdjustment: price_adjustment }),
        ...(is_required !== undefined && { isRequired: is_required }),
        ...(is_active !== undefined && { isActive: is_active }),
        ...(display_order !== undefined && { displayOrder: display_order }),
      },
    });

    res.json({
      success: true,
      data: modifier,
    });
  } catch (error) {
    logger.error('Update modifier error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update modifier',
      },
    });
  }
};

/**
 * Delete modifier
 * DELETE /api/v1/menu-items/:id/modifiers/:modifier_id
 */
const deleteModifier = async (req, res) => {
  try {
    const { modifier_id } = req.params;

    await prisma.modifier.delete({
      where: { id: modifier_id },
    });

    logger.info(`Modifier deleted: ${modifier_id}`);

    res.json({
      success: true,
      message: 'Modifier deleted successfully',
    });
  } catch (error) {
    logger.error('Delete modifier error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to delete modifier',
      },
    });
  }
};

module.exports = {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getMenuItems,
  getMenuItemById,
  createMenuItem,
  updateMenuItem,
  toggleAvailability,
  deleteMenuItem,
  addModifier,
  updateModifier,
  deleteModifier,
};