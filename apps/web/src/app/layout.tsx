import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Road Trip Planner',
  description: 'Know the real cost and a doable plan before you go: tolls, the 407 ETR, fuel, parking, weather and realistic driving days.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-CA">
      <body className="antialiased">{children}</body>
    </html>
  );
}
