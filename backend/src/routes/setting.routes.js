const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

router.use(authenticate);
router.use(authorize('admin'));

// Get all settings
router.get('/', async (req, res) => {
  try {
    const { location_id, category } = req.query;

    const where = {};
    if (location_id) where.locationId = location_id;
    if (category) where.category = category;

    const settings = await prisma.setting.findMany({
      where,
      orderBy: { key: 'asc' },
    });

    res.json({
      success: true,
      data: settings,
    });
  } catch (error) {
    logger.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch settings',
      },
    });
  }
});

// Update setting
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value, location_id } = req.body;

    const setting = await prisma.setting.upsert({
      where: {
        locationId_key: {
          locationId: location_id || null,
          key: key,
        },
      },
      update: {
        value,
        updatedBy: req.user.id,
      },
      create: {
        locationId: location_id,
        key,
        value,
        updatedBy: req.user.id,
      },
    });

    logger.info(`Setting updated: ${key}`);

    res.json({
      success: true,
      data: setting,
    });
  } catch (error) {
    logger.error('Update setting error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to update setting',
      },
    });
  }
});

module.exports = router;