const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menu.controller');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

router.get('/', menuController.getCategories);
router.post('/', authorize('admin'), menuController.createCategory);
router.put('/:id', authorize('admin'), menuController.updateCategory);
router.delete('/:id', authorize('admin'), menuController.deleteCategory);

module.exports = router;