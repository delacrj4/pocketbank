import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { AccountKind, Dashboard, TransferReview } from './models';

@Component({
  selector: 'app-root',
  imports: [CurrencyPipe, DatePipe, FormsModule],
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly http = inject(HttpClient);
  private readonly writeOptions = { headers: { 'X-PocketBank-Request': '1' }, timeout: 10000 };
  // The API owns the data. Signals hold the latest snapshot for the template.
  protected readonly state = signal<Dashboard | null>(null);
  protected readonly accounts = computed(() => this.state()?.accounts ?? []);
  protected readonly savings = computed(() => this.accounts().find(account => account.kind === 'savings'));
  protected readonly totalCents = computed(() => this.accounts().reduce((sum, account) => sum + account.balanceCents, 0));
  protected readonly historyFilter = signal<'all' | AccountKind>('all');
  protected readonly transactions = computed(() => {
    const filter = this.historyFilter();
    return (this.state()?.transactions ?? []).filter(item => filter === 'all' || item.from === filter || item.to === filter);
  });
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly registerMode = signal(false);
  protected readonly transferOpen = signal(false);
  protected readonly review = signal<TransferReview | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected email = '';
  protected password = '';
  protected confirmPassword = '';
  protected displayName = '';
  protected from: AccountKind = 'checking';
  protected destinationMode: 'own' | 'other' = 'own';
  protected recipientNumber = '';
  protected amount = '';

  constructor() { void this.restoreSession(); }

  private async restoreSession(): Promise<void> {
    try { await this.refresh(); }
    catch (error) {
      if (!(error instanceof HttpErrorResponse && error.status === 401)) this.showError(error);
    } finally { this.loading.set(false); }
  }

  private async refresh(): Promise<void> {
    const snapshot = await firstValueFrom(this.http.get<Dashboard>('/api/dashboard', { timeout: 10000 }));
    this.state.set(snapshot);
  }

  private showError(error: unknown): void {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 401) { this.state.set(null); this.transferOpen.set(false); this.review.set(null); }
      this.error.set(error.error?.message ?? 'Could not reach the server. Try again.');
    } else { this.error.set('Could not complete the request. Try again.'); }
  }

  protected async authenticate(): Promise<void> {
    if (this.busy()) return;
    if (this.registerMode() && this.password !== this.confirmPassword) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.busy.set(true); this.error.set('');
    try {
      await firstValueFrom(this.http.post(`/api/auth/${this.registerMode() ? 'register' : 'login'}`, {
        email: this.email, password: this.password, displayName: this.displayName,
        ...(this.registerMode() ? { confirmPassword: this.confirmPassword } : {}),
      }, this.writeOptions));
      this.password = '';
      this.confirmPassword = '';
      await this.refresh();
      this.email = ''; this.displayName = '';
      this.message.set(''); this.historyFilter.set('all');
    } catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }

  protected async logout(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}, this.writeOptions));
      this.state.set(null); this.review.set(null); this.transferOpen.set(false);
      this.message.set(''); this.password = ''; this.confirmPassword = '';
    } catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }

  protected async openSavings(): Promise<void> {
    if (this.savings() || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      this.state.set(await firstValueFrom(this.http.post<Dashboard>('/api/accounts/savings', {}, this.writeOptions)));
      this.message.set('Savings account opened. Balance: $0.00.');
    } catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }

  protected startTransfer(): void {
    this.review.set(null); this.error.set(''); this.message.set('');
    this.amount = ''; this.recipientNumber = ''; this.from = 'checking';
    this.destinationMode = this.savings() ? 'own' : 'other';
    this.transferOpen.set(true);
  }

  protected async reviewTransfer(): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    const input = this.amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(input)) {
      this.error.set('Enter a positive dollar amount with up to two decimal places.'); return;
    }
    const [dollars, cents = ''] = input.split('.');
    const amountCents = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      this.error.set('Enter an amount greater than $0.00.'); return;
    }
    const sourceNumber = this.accounts().find(account => account.kind === this.from)?.number;
    const destinationNumber = this.destinationMode === 'other' ? this.recipientNumber.trim().toUpperCase()
      : this.accounts().find(account => account.kind !== this.from)?.number;
    if (this.destinationMode === 'other' && !/^[0-9A-F]{16}$/.test(destinationNumber ?? '')) {
      this.error.set('Invalid account number. Enter the recipient’s 16-character checking account number.');
      return;
    }
    if (!sourceNumber || !destinationNumber) { this.error.set('Choose a destination account.'); return; }
    this.busy.set(true);
    try {
      const preview = await firstValueFrom(this.http.post<Omit<TransferReview, 'requestId'>>('/api/transfers/preview', {
        sourceNumber, destinationNumber, amountCents,
      }, this.writeOptions));
      this.review.set({ ...preview, requestId: crypto.randomUUID() });
    } catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }

  protected async confirmTransfer(): Promise<void> {
    const transfer = this.review();
    if (!transfer || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      const result = await firstValueFrom(this.http.post<{ reference: string }>('/api/transfers', transfer, this.writeOptions));
      this.review.set(null); this.transferOpen.set(false);
      this.message.set(`Transfer complete. Reference: ${result.reference}`);
      await this.refresh();
    } catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }

  protected async refreshDashboard(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    try { await this.refresh(); }
    catch (error) { this.showError(error); }
    finally { this.busy.set(false); }
  }
}
