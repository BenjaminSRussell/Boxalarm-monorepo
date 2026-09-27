import { createLobHealthHandler } from '@boxalarm/health';

// GET /api/v1/{service}/health/{liveness,readiness}: DynamoDB and the platform bus.
export const handler = createLobHealthHandler('notification-service');
