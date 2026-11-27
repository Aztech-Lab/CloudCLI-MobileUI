// [local] Thin HTTP routes for the settings page's Server section.
import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { createServerControlService } from './server-control.service.js';
import type { createServerSettingsService } from './server-settings.js';

function readBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AppError(`${name} must be true or false`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value;
}

/** Creates the server-control router; exported for the module entry and the route tests. */
export function createServerControlRouter(
  serverControlService: ReturnType<typeof createServerControlService>,
): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(createApiSuccessResponse(serverControlService.getAvailability()));
  });

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      res.json(createApiSuccessResponse(await serverControlService.getStatus()));
    }),
  );

  router.put(
    '/autostart',
    asyncHandler(async (req, res) => {
      const enabled = readBoolean((req.body as Record<string, unknown> | undefined)?.enabled, 'enabled');
      res.json(createApiSuccessResponse(await serverControlService.setAutostart(enabled)));
    }),
  );

  router.post(
    '/restart',
    asyncHandler(async (req, res) => {
      const deployValue = (req.body as Record<string, unknown> | undefined)?.deploy;
      const deploy = deployValue === undefined ? false : readBoolean(deployValue, 'deploy');
      res.status(202).json(createApiSuccessResponse(await serverControlService.restart({ deploy })));
    }),
  );

  router.post(
    '/stop',
    asyncHandler(async (_req, res) => {
      res.status(202).json(createApiSuccessResponse(await serverControlService.stop()));
    }),
  );

  return router;
}

/** GET/PATCH /settings: the server switches of Settings > MobileUI (values apply after a restart). */
export function createServerSettingsRouter(
  serverSettingsService: ReturnType<typeof createServerSettingsService>,
): express.Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.json(createApiSuccessResponse(serverSettingsService.getSettings()));
  });

  router.patch('/', (req, res) => {
    res.json(createApiSuccessResponse(serverSettingsService.updateSettings(req.body)));
  });

  return router;
}
