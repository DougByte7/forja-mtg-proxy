import { ClerkForm } from "../../shared/ClerkForm";
import { withClerkUi } from "../../shared/clerk";
import { mount } from "../../shared/query";

// A interface do Clerk só baixa nesta tela, e tem que ser pedida antes do
// primeiro `loadClerk` (ver `withClerkUi`).
withClerkUi();

mount(<ClerkForm mode="signIn" />);
