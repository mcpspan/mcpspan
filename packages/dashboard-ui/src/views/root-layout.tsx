import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Light only for now. Stated rather than left to the browser, so form
    // controls and scrollbars match the interface instead of following whatever
    // the operating system is set to.
    <html lang="en" style={{ colorScheme: 'light' }}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
