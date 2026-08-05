import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FounderShield',
  description: 'Anti-scraping protection and evidence capture for solo founders.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
