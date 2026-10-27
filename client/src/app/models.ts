export type AccountKind = 'checking' | 'savings';
export interface Account { kind: AccountKind; name: string; number: string; balanceCents: number; }
export interface Transaction {
  reference: string; description: string; createdAt: string; amountCents: number;
  from: AccountKind | null; to: AccountKind | null; direction: 'internal' | 'incoming' | 'outgoing';
}
export interface Dashboard {
  user: { id: string; displayName: string; email: string };
  accounts: Account[];
  transactions: Transaction[];
}
export interface TransferReview {
  sourceNumber: string; destinationNumber: string; amountCents: number;
  recipientName: string; destinationKind: AccountKind; requestId: string;
}
