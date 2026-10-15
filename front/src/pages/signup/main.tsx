import { ClerkForm } from "../../shared/ClerkForm";
import { clerkEnabled, withClerkUi } from "../../shared/clerk";
import { mount } from "../../shared/query";
import { Signup } from "./Signup";
import "./style.css";

// A interface do Clerk só baixa nesta tela, e tem que ser pedida antes do
// primeiro `loadClerk` (ver `withClerkUi`).
withClerkUi();

// Sem Clerk no build, o cadastro com convite de antes (sai na virada).
mount(clerkEnabled ? <ClerkForm mode="signUp" /> : <Signup />);
