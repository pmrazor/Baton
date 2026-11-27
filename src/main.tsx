import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "pretendard/dist/web/variable/pretendardvariable.css";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./scrollbars.css";
import { detectPlatform } from "./platform";
import { applyCachedTheme } from "./extensions/themes";

document.documentElement.dataset.platform = detectPlatform(
  navigator.userAgent || navigator.platform,
);

applyCachedTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
