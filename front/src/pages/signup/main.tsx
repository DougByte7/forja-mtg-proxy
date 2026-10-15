import { ClerkForm } from "../../shared/ClerkForm";
import { clerkEnabled } from "../../shared/clerk";
import { mount } from "../../shared/query";
import { Signup } from "./Signup";
import "./style.css";

// Sem Clerk no build, o cadastro com convite de antes (sai na virada).
mount(clerkEnabled ? <ClerkForm mode="signUp" /> : <Signup />);
