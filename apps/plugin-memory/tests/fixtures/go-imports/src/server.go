package main

import "fmt"
import alias "example.com/alias"
import . "example.com/dot"
import _ "example.com/blank"
import (
	"net/http"
	json "encoding/json"
	. "example.com/group-dot"
	_ "example.com/group-blank"
)

func Serve() string {
	return fmt.Sprintf("%s:%s", alias.Name, http.MethodGet)
}
