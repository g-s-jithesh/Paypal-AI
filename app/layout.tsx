import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ChargebackShield — AI Dispute Autopilot for PayPal',
  description: 'Autonomous AI Dispute & Refund Resolution Autopilot for PayPal',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
