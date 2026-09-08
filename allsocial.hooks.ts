import { timingSafeEqual } from 'node:crypto';

const expectedToken = process.env.BUSYBASE_INTERNAL_TOKEN || '';

const tokenMatches = (candidate: string) => {
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(candidate);
  return (
    expected.length > 0 &&
    expected.length === received.length &&
    timingSafeEqual(expected, received)
  );
};

export const onRequest = (request: Request) => {
  if (new URL(request.url).pathname === '/healthz') return;
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!expectedToken)
    return Response.json({ error: 'BusyBase internal token is not configured.' }, { status: 503 });
  if (!tokenMatches(token)) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
};
