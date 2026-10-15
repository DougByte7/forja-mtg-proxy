import { ClerkForm } from "../../shared/ClerkForm";
import { clerkEnabled } from "../../shared/clerk";
import { mount } from "../../shared/query";
import { Login } from "./Login";
import "./style.css";

// Sem Clerk no build, a conta própria de antes (sai na virada).
mount(clerkEnabled ? <ClerkForm mode="signIn" /> : <Login />);
