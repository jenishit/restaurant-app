import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';
import toast from 'react-hot-toast';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000';

export const useWebSocket = (locationId) => {
  const socketRef = useRef(null);
  const [isConnected, setIsConnected] = useState(false);
  const { token, user } = useAuthStore();

  useEffect(() => {
    if (!token || !user) return;

    // Initialize socket connection
    const socket = io(WS_URL, {
      auth: {
        token,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    // Connection events
    socket.on('connect', () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      
      // Subscribe to location updates
      if (locationId || user.locationId) {
        socket.emit('subscribe', {
          location_id: locationId || user.locationId,
        });
      }
    });

    socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error);
      setIsConnected(false);
    });

    // Cleanup on unmount
    return () => {
      socket.close();
    };
  }, [token, user, locationId]);

  // Subscribe to specific events
  const subscribe = useCallback((event, callback) => {
    if (!socketRef.current) return;

    socketRef.current.on(event, callback);

    // Return unsubscribe function
    return () => {
      socketRef.current?.off(event, callback);
    };
  }, []);

  // Subscribe to order events
  const subscribeToOrder = useCallback((orderId) => {
    if (!socketRef.current) return;

    socketRef.current.emit('subscribe:order', { order_id: orderId });
  }, []);

  // Subscribe to table events
  const subscribeToTable = useCallback((tableId) => {
    if (!socketRef.current) return;

    socketRef.current.emit('subscribe:table', { table_id: tableId });
  }, []);

  // Emit event
  const emit = useCallback((event, data) => {
    if (!socketRef.current) return;

    socketRef.current.emit(event, data);
  }, []);

  // Get socket instance (use this in effects, not during render)
  const getSocket = useCallback(() => socketRef.current, []);

  return {
    getSocket,
    isConnected,
    subscribe,
    subscribeToOrder,
    subscribeToTable,
    emit,
  };
};

// ============================================
// Hook for Kitchen Display - Order Updates
// ============================================
export const useKitchenSocket = (locationId) => {
  const { subscribe, isConnected } = useWebSocket(locationId);
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    if (!isConnected) return;

    // Listen for new orders
    const unsubscribeNew = subscribe('order:created', (data) => {
      toast.success(`New order: ${data.order_number} - Table ${data.table_number}`);
      setOrders((prev) => [data, ...prev]);
    });

    // Listen for order status updates
    const unsubscribeStatus = subscribe('order:status_updated', (data) => {
      setOrders((prev) =>
        prev.map((order) =>
          order.order_id === data.order_id
            ? { ...order, status: data.new_status }
            : order
        )
      );
    });

    return () => {
      unsubscribeNew?.();
      unsubscribeStatus?.();
    };
  }, [isConnected, subscribe]);

  return { orders, setOrders, isConnected };
};

// ============================================
// Hook for Waiter - Table & Order Updates
// ============================================
export const useWaiterSocket = (locationId) => {
  const { subscribe, isConnected } = useWebSocket(locationId);

  useEffect(() => {
    if (!isConnected) return;

    // Listen for table status changes
    const unsubscribeTable = subscribe('table:status_changed', (data) => {
      toast(`Table ${data.table_number} is now ${data.status}`);
    });

    // Listen for menu availability changes
    const unsubscribeMenu = subscribe('menu:availability_changed', (data) => {
      if (!data.is_available) {
        toast.error(`${data.item_name} is now out of stock`);
      }
    });

    // Listen for payment completion
    const unsubscribePayment = subscribe('payment:completed', (data) => {
      toast.success(`Payment received for ${data.order_number}`);
    });

    return () => {
      unsubscribeTable?.();
      unsubscribeMenu?.();
      unsubscribePayment?.();
    };
  }, [isConnected, subscribe]);

  return { isConnected };
};

// ============================================
// Hook for Cashier - Payment Updates
// ============================================
export const useCashierSocket = (locationId) => {
  const { subscribe, isConnected } = useWebSocket(locationId);

  useEffect(() => {
    if (!isConnected) return;

    // Listen for orders ready for checkout
    const unsubscribeReady = subscribe('order:status_updated', (data) => {
      if (data.new_status === 'served') {
        toast(`Order ${data.order_number} ready for checkout`);
      }
    });

    return () => {
      unsubscribeReady?.();
    };
  }, [isConnected, subscribe]);

  return { isConnected };
};

// ============================================
// Hook for Admin - All Updates
// ============================================
export const useAdminSocket = (locationId) => {
  const { subscribe, isConnected } = useWebSocket(locationId);

  useEffect(() => {
    if (!isConnected) return;

    // Listen for all important events
    const unsubscribeOrder = subscribe('order:created', () => {
      // Can show notification or update dashboard
      // data parameter removed as it's not being used
    });

    const unsubscribePayment = subscribe('payment:completed', () => {
      // Update revenue metrics
      // data parameter removed as it's not being used
    });

    return () => {
      unsubscribeOrder?.();
      unsubscribePayment?.();
    };
  }, [isConnected, subscribe]);

  return { isConnected };
};

export default useWebSocket;