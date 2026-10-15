export interface ClientTypeRule {
  readonly type: string;
  readonly startsWith?: readonly string[];
  readonly contains?: readonly string[];
  readonly note?: string;
}

/** The rules, in the order they are tried. */
export declare const CLIENT_TYPE_RULES: readonly ClientTypeRule[];

/**
 * The type of the client that called itself `clientName`: the first rule that
 * matches, `other` when none does, `unknown` when there is no name.
 */
export declare function clientTypeOf(clientName: string | null | undefined): string;

/** How a type is shown. A type with no label is shown as it is. */
export declare function clientLabel(clientType: string): string;
