import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "pretendard/dist/web/variable/pretendardvariable.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./scrollbars.css";
import { detectPlatform } from "./platform";

document.documentElement.dataset.platform = detectPlatform(
  navigator.userAgent || navigator.platform,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
