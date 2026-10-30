import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PhonePage } from "./party/PhonePage";
import "./styles.css";

const isPhone = location.pathname.startsWith("/join");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isPhone ? <PhonePage /> : <App />}</StrictMode>,
);
