import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

// An incoming X-Request-Id is accepted only if it is a canonical UUID; anything else is replaced
// (observability.md). Accepting free text would let a caller write arbitrary strings into our logs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REQUEST_ID_HEADER = 'X-Request-Id';

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId = incoming && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};
