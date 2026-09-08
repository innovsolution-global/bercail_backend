import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Codes d'erreur métier.
 *
 * Le code est stable et destiné aux clients (Flutter/React) : il permet
 * de réagir précisément (« panier vide », « code OTP expiré ») sans
 * analyser un message en français.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'SERVER_ERROR',

  // Authentification
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  ACCOUNT_PENDING: 'ACCOUNT_PENDING',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  PUBLIC_REGISTRATION_FORBIDDEN: 'PUBLIC_REGISTRATION_FORBIDDEN',

  // Carte et panier
  MENU_ITEM_UNAVAILABLE: 'MENU_ITEM_UNAVAILABLE',
  MENU_OPTION_INVALID: 'MENU_OPTION_INVALID',
  OPTION_GROUP_REQUIRED: 'OPTION_GROUP_REQUIRED',
  CART_EMPTY: 'CART_EMPTY',

  // Commandes
  RESTAURANT_CLOSED: 'RESTAURANT_CLOSED',
  DELIVERY_DISABLED: 'DELIVERY_DISABLED',
  PICKUP_DISABLED: 'PICKUP_DISABLED',
  MINIMUM_ORDER_NOT_REACHED: 'MINIMUM_ORDER_NOT_REACHED',
  ADDRESS_REQUIRED: 'ADDRESS_REQUIRED',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',

  // Promotions
  PROMOTION_NOT_FOUND: 'PROMOTION_NOT_FOUND',
  PROMOTION_EXPIRED: 'PROMOTION_EXPIRED',
  PROMOTION_LIMIT_REACHED: 'PROMOTION_LIMIT_REACHED',
  PROMOTION_MINIMUM_NOT_REACHED: 'PROMOTION_MINIMUM_NOT_REACHED',

  // Paiements
  PAYMENT_ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  PAYMENT_METHOD_DISABLED: 'PAYMENT_METHOD_DISABLED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',

  // Livraisons
  DRIVER_UNAVAILABLE: 'DRIVER_UNAVAILABLE',
  DRIVER_SUSPENDED: 'DRIVER_SUSPENDED',
  DELIVERY_ALREADY_ASSIGNED: 'DELIVERY_ALREADY_ASSIGNED',
  DELIVERY_NOT_ASSIGNED: 'DELIVERY_NOT_ASSIGNED',
  INVALID_DELIVERY_TRANSITION: 'INVALID_DELIVERY_TRANSITION',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_TOO_MANY_ATTEMPTS: 'OTP_TOO_MANY_ATTEMPTS',
  OTP_ALREADY_USED: 'OTP_ALREADY_USED',

  // Administration
  CANNOT_MODIFY_SUPER_ADMIN: 'CANNOT_MODIFY_SUPER_ADMIN',
  CANNOT_MODIFY_SELF: 'CANNOT_MODIFY_SELF',
  PERMISSION_NOT_DELEGABLE: 'PERMISSION_NOT_DELEGABLE',
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface AppExceptionPayload {
  code: ErrorCode | string;
  message: string;
  status: HttpStatus;
  details?: Record<string, unknown>;
}

/**
 * Exception métier.
 *
 * Elle porte un code stable, un message déjà rédigé en français pour
 * l'utilisateur final, et un statut HTTP. Elle ne contient jamais de
 * détail technique exploitable par un attaquant.
 */
export class AppException extends HttpException {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(payload: AppExceptionPayload) {
    super(
      {
        code: payload.code,
        message: payload.message,
        details: payload.details,
      },
      payload.status,
    );
    this.code = payload.code;
    this.details = payload.details;
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException({ code, message, status: HttpStatus.BAD_REQUEST, details });
  }

  static unauthorized(code: string, message: string) {
    return new AppException({ code, message, status: HttpStatus.UNAUTHORIZED });
  }

  static forbidden(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException({ code, message, status: HttpStatus.FORBIDDEN, details });
  }

  static notFound(message: string, code: string = ERROR_CODES.NOT_FOUND) {
    return new AppException({ code, message, status: HttpStatus.NOT_FOUND });
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException({ code, message, status: HttpStatus.CONFLICT, details });
  }

  static unprocessable(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException({ code, message, status: HttpStatus.UNPROCESSABLE_ENTITY, details });
  }

  static tooManyRequests(code: string, message: string) {
    return new AppException({ code, message, status: HttpStatus.TOO_MANY_REQUESTS });
  }
}
