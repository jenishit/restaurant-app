const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

router.use(authenticate);

// Get all locations
router.get('/', async (req, res) => {
  try {
    const { is_active } = req.query;
    const where = {};
    if (is_active !== undefined) where.isActive = is_active === 'true';

    const locations = await prisma.location.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    res.json({
      success: true,
      data: locations,
    });
  } catch (error) {
    logger.error('Get locations error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch locations',
      },
    });
  }
});

// Get location by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const location = await prisma.location.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            tables: true,
            users: true,
            orders: true,
          },
        },
      },
    });

    if (!location) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Location not found',
        },
      });
    }

    res.json({
      success: true,
      data: location,
    });
  } catch (error) {
    logger.error('Get location error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch location',
      },
    });
  }
});

// Create location
router.post('/', authorize('admin'), async (req, res) => {
  try {
    const {
      name,
      address,
      city,
      state,
      country,
      postal_code,
      phone,
      email,
      timezone,
      settings,
    } = req.body;

    if (!name || !address || !city || !country || !phone) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required fields',
        },
      });
    }

    const location = await prisma.location.create({
      data: {
        name,
        address,
        city,
        state,
        country,
        postalCode: postal_code,
        phone,
        email,
        timezone: timezone || 'UTC',
        settings: settings || {},
      },
    });

    logger.info(`Location created: ${location.name}`);

    res.status(201).json({
      success: true,
      data: location,
    });
  } catch (error) {
    logger.error('Create location error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to create location',
      },
    });
  }
});

// Update location
router.put('/:id', authorize('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {};

    const allowedFields = [
      'name', 'address', 'city', 'state', 'country', 'postal_code',
      'phone', 'email', 'timezone', 'is_active', 'settings'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        const prismaField = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        updateData[prismaField] = req.body[field];
      }
    }

    const location = await prisma.location.update({
      where: { id },
      data: updateData,
    });

    logger.info(`Location updated: ${location.name}`);

    res.json({
      success: true,
      data: location,
    });
  } catch (error) {
    logger.error('Update location error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update location',
      },
    });
  }
});

module.exports = router;