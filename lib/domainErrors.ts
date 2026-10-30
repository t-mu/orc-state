/** Expected domain refusals; HTTP mapping must never depend on error wording. */
export class NotFoundError extends Error { override name = 'NotFoundError'; }
export class ConflictError extends Error { override name = 'ConflictError'; }
export class InputError extends Error { override name = 'InputError'; }
export class ForbiddenError extends Error { override name = 'ForbiddenError'; }
export class UnauthenticatedError extends Error { override name = 'UnauthenticatedError'; }
