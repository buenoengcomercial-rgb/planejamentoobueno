import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="mb-4 text-xl text-muted-foreground">P\u00e1gina n\u00e3o encontrada</p>
        <Link to="/" className="text-primary underline hover:text-primary/90">
          Voltar para o in\u00edcio
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
