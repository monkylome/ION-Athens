import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import "@fontsource-variable/sofia-sans-condensed";
import "@fontsource-variable/sofia-sans";
import "./styles/app.css";
import { Missions } from "./missions/Missions";
import { DeviceSettings } from "./devices/Settings";
import { Phone } from "./phone/Phone";
import { Stage } from "./stage/Stage";

function Home() {
  return (
    <main className="page" data-surface="phone">
      <h1>ION Athens</h1>
      <p className="page__lead">
        Φωνητική καθοδήγηση πεζών στην Αθήνα, με έμφαση στους ανθρώπους με αναπηρία όρασης. Η διαδρομή αλλάζει στην τελευταία γωνία πριν από το εμπόδιο.
      </p>
      <nav aria-label="Οθόνες">
        <Link className="btn" to="/stage">Οθόνη σκηνής, για το κοινό</Link>
        <Link className="btn" to="/phone">Τηλέφωνο, στο χέρι του πεζού</Link>
        <Link className="btn" to="/missions">Αποστολές πολιτών</Link>
        <Link className="btn" to="/phone/devices">Σήματα συσκευής</Link>
      </nav>
      <p>Ο πεζός και το εμπόδιο της επίδειξης είναι προσομοίωση. Τα δεδομένα του Δήμου προέρχονται από το AthensGov Sandbox και είναι δοκιμαστικά.</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/stage" element={<Stage />} />
      <Route path="/missions" element={<Missions />} />
      <Route path="/phone" element={<Phone />} />
      <Route path="/phone/devices" element={<DeviceSettings />} />
    </Routes>
  </BrowserRouter>,
);
