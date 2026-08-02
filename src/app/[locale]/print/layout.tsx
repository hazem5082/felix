/**
 * Print surface — contracts and reports. Deliberately NOT inside the
 * (app) route group: these pages open in a new tab headed for the
 * browser's print dialog, so they carry no sidebar, no topbar, no glass
 * theme — a white A4-ish sheet that looks the same on screen as on
 * paper. Auth still happens per page; this layout is styling only.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#e8e8ec] py-8 text-black print:bg-white print:py-0">
      <div className="mx-auto w-[210mm] max-w-full bg-white p-[15mm] shadow-xl print:w-auto print:p-0 print:shadow-none">
        {children}
      </div>
    </div>
  );
}
