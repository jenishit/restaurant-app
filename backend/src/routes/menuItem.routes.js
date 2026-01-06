const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menu.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', menuController.getMenuItems);
router.get('/:id', menuController.getMenuItemById);
router.post('/', authorize('admin'), menuController.createMenuItem);
router.put('/:id', authorize('admin'), menuController.updateMenuItem);
router.patch('/:id/availability', authorize('kitchen', 'admin'), menuController.toggleAvailability);
router.delete('/:id', authorize('admin'), menuController.deleteMenuItem);

// Modifiers
router.post('/:id/modifiers', authorize('admin'), menuController.addModifier);
router.put('/:id/modifiers/:modifier_id', authorize('admin'), menuController.updateModifier);
router.delete('/:id/modifiers/:modifier_id', authorize('admin'), menuController.deleteModifier);

module.exports = router;