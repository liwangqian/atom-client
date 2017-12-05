import React from "react";
import { connect } from "react-redux";
import SignupForm from "./SignupForm";
import EmailConfirmationForm from "./EmailConfirmationForm";
import LoginForm from "./LoginForm";
import TeamCreationForm from "./TeamCreationForm";
import TeamSelectionForm from "./TeamSelectionForm";
import TeamMemberSelectionForm from "./TeamMemberSelectionForm";

const mapStateToProps = ({ onboarding }) => ({ ...onboarding });

export default connect(mapStateToProps)(({ step, props }) => {
	const nextProps = { ...props };
	const views = {
		signUp: <SignupForm {...nextProps} />,
		confirmEmail: <EmailConfirmationForm {...nextProps} />,
		login: <LoginForm {...nextProps} />,
		createTeam: <TeamCreationForm {...nextProps} />,
		selectTeam: <TeamSelectionForm {...nextProps} />,
		identifyMembers: <TeamMemberSelectionForm {...nextProps} />
	};
	return views[step];
});