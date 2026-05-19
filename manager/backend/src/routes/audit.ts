import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { listAuditEvents, listDistinctActions } from '../services/audit.js';

const router = Router();

router.get('/', authMiddleware, requirePermission('audit.view'), (req: AuthenticatedRequest, res: Response) => {
  const result = listAuditEvents({
    actor: req.query.actor as string | undefined,
    action: req.query.action as string | undefined,
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    cursor: req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined,
  });
  res.json(result);
});

router.get('/actions', authMiddleware, requirePermission('audit.view'), (_req: AuthenticatedRequest, res: Response) => {
  res.json({ actions: listDistinctActions() });
});

router.get('/export', authMiddleware, requirePermission('audit.export'), (req: AuthenticatedRequest, res: Response) => {
  const format = (req.query.format as string) || 'json';
  // We don't paginate the export — caller takes the firehose. Practical cap
  // is the retention window, default 180 days, with a hard limit.
  const events: ReturnType<typeof listAuditEvents>['events'] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = listAuditEvents({
      actor: req.query.actor as string | undefined,
      action: req.query.action as string | undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: 500,
      cursor,
    });
    events.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (format === 'csv') {
    const header = 'id,ts,actor,action,target,ip,success\n';
    const rows = events.map(e => [
      e.id,
      JSON.stringify(e.ts),
      JSON.stringify(e.actorUsername),
      JSON.stringify(e.action),
      JSON.stringify(e.target ?? ''),
      JSON.stringify(e.ip ?? ''),
      e.success,
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`);
    res.send(header + rows);
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.json"`);
  res.send(JSON.stringify({ events }, null, 2));
});

export default router;
